//! tabula-markets
//!
//! On-chain half of TabulaMarkets: a dynamic-LMSR prop-bet AMM whose price
//! curve is steered by an off-chain TabFM ensemble oracle and whose
//! settlement is proven trustlessly via CPI into the TxLINE program.
//!
//! For the hackathon MVP we support:
//!
//!   * up to 10 outcome classes per market (hard limit of TabFM classifier),
//!   * fixed-point LMSR with `b` (liquidity parameter) updated by oracle,
//!   * single-sided USDC liquidity vault,
//!   * `place_bet`, `settle_via_txline` (CPI), and `claim_winnings`.
//!
//! Fixed-point convention: all probabilities and `q`/`b` are stored in
//! `Q_SCALE = 1_000_000` micro-units. LMSR cost is approximated with a
//! Taylor-expanded logsumexp that keeps everything integer-safe on-chain.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use txline_mock::cpi::accounts::ValidateStat as TxLineValidateStatAccounts;
use txline_mock::program::TxlineMock;
use txline_mock::{self, StatReceipt, StatRoot};

declare_id!("TabuLA11111111111111111111111111111111111111");

pub const Q_SCALE: u64        = 1_000_000;
pub const MAX_OUTCOMES: usize = 10;
pub const FEE_BPS: u16        = 200;   // 2% spread routed to LP treasury
pub const SETTLE_FEE_BPS: u16 = 50;    // 0.5% off net winnings on payout

#[program]
pub mod tabula_markets {
    use super::*;

    // ---------------------------------------------------------------
    // Pool lifecycle
    // ---------------------------------------------------------------

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority       = ctx.accounts.authority.key();
        pool.usdc_mint       = ctx.accounts.usdc_mint.key();
        pool.vault           = ctx.accounts.vault.key();
        pool.total_liquidity = 0;
        pool.fees_accrued    = 0;
        pool.bump            = ctx.bumps.pool;
        pool.vault_bump      = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, TabulaError::ZeroAmount);

        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.lp_token_account.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.lp.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;

        let pool = &mut ctx.accounts.pool;
        pool.total_liquidity = pool.total_liquidity.checked_add(amount).unwrap();
        Ok(())
    }

    // ---------------------------------------------------------------
    // Market lifecycle
    // ---------------------------------------------------------------

    pub fn create_market(
        ctx: Context<CreateMarket>,
        match_id: [u8; 32],
        stat_type: [u8; 16],
        outcome_count: u8,
        bin_edges: Vec<u64>,       // len = outcome_count + 1
        initial_probs: Vec<u64>,   // len = outcome_count, sums to Q_SCALE
        liquidity_b: u64,          // initial LMSR liquidity parameter
    ) -> Result<()> {
        require!(
            (outcome_count as usize) <= MAX_OUTCOMES && outcome_count >= 2,
            TabulaError::OutcomeCountOutOfRange
        );
        require!(
            bin_edges.len() == outcome_count as usize + 1,
            TabulaError::BinEdgeMismatch
        );
        require!(
            initial_probs.len() == outcome_count as usize,
            TabulaError::ProbCountMismatch
        );
        require!(liquidity_b > 0, TabulaError::ZeroLiquidityParam);

        let sum: u64 = initial_probs.iter().sum();
        require!(
            sum.abs_diff(Q_SCALE) <= (outcome_count as u64),
            TabulaError::ProbabilitiesNotNormalized
        );

        let market = &mut ctx.accounts.market;
        market.match_id      = match_id;
        market.stat_type     = stat_type;
        market.outcome_count = outcome_count;
        market.bin_edges     = [0u64; MAX_OUTCOMES + 1];
        market.probs         = [0u64; MAX_OUTCOMES];
        market.q             = [0i64; MAX_OUTCOMES];
        market.liquidity_b   = liquidity_b;
        market.status        = MarketStatus::Trading as u8;
        market.winning_outcome = u8::MAX;
        market.creator       = ctx.accounts.creator.key();
        market.bump          = ctx.bumps.market;

        for (i, e) in bin_edges.iter().enumerate() { market.bin_edges[i] = *e; }
        for (i, p) in initial_probs.iter().enumerate() { market.probs[i] = *p; }

        emit!(MarketCreated { match_id, stat_type, outcome_count });
        Ok(())
    }

    /// Oracle-only: push a new ensemble prediction and adjust the liquidity
    /// parameter `b` based on ensemble divergence (encoded off-chain).
    pub fn update_prediction(
        ctx: Context<UpdatePrediction>,
        new_probs: Vec<u64>,
        new_b: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::NotTrading);
        require!(
            new_probs.len() == market.outcome_count as usize,
            TabulaError::ProbCountMismatch
        );
        require!(new_b > 0, TabulaError::ZeroLiquidityParam);

        for (i, p) in new_probs.iter().enumerate() { market.probs[i] = *p; }
        market.liquidity_b = new_b;

        emit!(PredictionUpdated {
            match_id: market.match_id,
            new_b,
        });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------

    /// Place a bet on `outcome_idx` by depositing `usdc_amount`.
    ///
    /// Effective marginal price: `p_i + fee`. We keep bookkeeping via
    /// `market.q[i]` (share tokens minted) so an LMSR-style cost can be
    /// reconstructed off-chain for analytics, while on-chain payout uses
    /// the standard "1 USDC per winning share" convention typical of
    /// hackathon-scale LMSR AMMs.
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        outcome_idx: u8,
        usdc_amount: u64,
    ) -> Result<()> {
        require!(usdc_amount > 0, TabulaError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::NotTrading);
        require!(
            (outcome_idx as usize) < market.outcome_count as usize,
            TabulaError::OutcomeOutOfRange
        );

        let p_i = market.probs[outcome_idx as usize];
        // marginal price = p_i * (1 + fee_bps/10_000)
        let numer = (p_i as u128) * (10_000u128 + FEE_BPS as u128);
        let price_scaled = (numer / 10_000u128) as u64; // still in Q_SCALE

        // shares = usdc / price
        let shares = ((usdc_amount as u128) * (Q_SCALE as u128) / (price_scaled as u128)) as u64;
        require!(shares > 0, TabulaError::ShareCalcUnderflow);

        // Transfer USDC bettor -> vault
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.bettor_token_account.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.bettor.to_account_info(),
            },
        );
        token::transfer(cpi, usdc_amount)?;

        // Book position
        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner        = ctx.accounts.bettor.key();
            position.market       = market.key();
            position.outcome_idx  = outcome_idx;
            position.bump         = ctx.bumps.position;
        } else {
            require!(position.outcome_idx == outcome_idx, TabulaError::OutcomeMismatch);
        }
        position.shares    = position.shares.checked_add(shares).unwrap();
        position.usdc_in   = position.usdc_in.checked_add(usdc_amount).unwrap();
        position.claimed   = false;

        market.q[outcome_idx as usize] =
            market.q[outcome_idx as usize].checked_add(shares as i64).unwrap();

        let pool = &mut ctx.accounts.pool;
        let fee = usdc_amount
            .checked_mul(FEE_BPS as u64).unwrap()
            .checked_div(10_000u64).unwrap();
        pool.fees_accrued = pool.fees_accrued.checked_add(fee).unwrap();

        emit!(BetPlaced {
            match_id: market.match_id,
            outcome_idx,
            usdc_amount,
            shares,
            price_scaled,
        });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Settlement via CPI to TxLINE
    // ---------------------------------------------------------------

    pub fn settle_via_txline(
        ctx: Context<SettleViaTxLine>,
        stat_type: [u8; 16],
        stat_value: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::AlreadySettled);
        require!(market.stat_type == stat_type, TabulaError::StatTypeMismatch);

        // CPI into TxLINE ----------------------------------------------
        let cpi_program  = ctx.accounts.txline_program.to_account_info();
        let cpi_accounts = TxLineValidateStatAccounts {
            payer:          ctx.accounts.payer.to_account_info(),
            stat_root:      ctx.accounts.stat_root.to_account_info(),
            receipt:        ctx.accounts.receipt.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        txline_mock::cpi::validate_stat(cpi_ctx, stat_type, stat_value, proof)?;

        // Reload receipt written by CPI callee.
        let receipt_data = ctx.accounts.receipt.try_borrow_data()?;
        // 8 discriminator + StatReceipt layout mirrored here
        let account = StatReceipt::try_deserialize(&mut &receipt_data[..])?;
        require!(account.verified, TabulaError::TxLineNotVerified);
        require!(account.stat_type == stat_type, TabulaError::StatTypeMismatch);
        drop(receipt_data);

        // Map `stat_value` to an outcome bin.
        let mut winning: Option<u8> = None;
        for i in 0..market.outcome_count as usize {
            let lo = market.bin_edges[i];
            let hi = market.bin_edges[i + 1];
            if account.stat_value >= lo && account.stat_value < hi {
                winning = Some(i as u8);
                break;
            }
        }
        let win_idx = winning.ok_or(error!(TabulaError::StatValueOutOfBins))?;
        market.winning_outcome = win_idx;
        market.status          = MarketStatus::Resolved as u8;

        emit!(MarketResolved {
            match_id:        market.match_id,
            stat_value:      account.stat_value,
            winning_outcome: win_idx,
        });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market   = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        require!(market.status == MarketStatus::Resolved as u8, TabulaError::NotResolved);
        require!(!position.claimed, TabulaError::AlreadyClaimed);

        let payout = if position.outcome_idx == market.winning_outcome {
            // 1 USDC per winning share, minus settlement fee
            let gross = position.shares;
            let net_winnings = gross.saturating_sub(position.usdc_in);
            let fee = net_winnings
                .checked_mul(SETTLE_FEE_BPS as u64).unwrap()
                .checked_div(10_000u64).unwrap();
            gross.saturating_sub(fee)
        } else {
            0
        };

        position.claimed = true;

        if payout > 0 {
            let pool_key = ctx.accounts.pool.key();
            let seeds: &[&[u8]] = &[b"vault", pool_key.as_ref(), &[ctx.accounts.pool.vault_bump]];
            let signer = &[seeds];
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault.to_account_info(),
                    to:        ctx.accounts.bettor_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            );
            token::transfer(cpi, payout)?;
        }

        emit!(WinningsClaimed {
            owner:   position.owner,
            payout,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init, payer = authority,
        space = 8 + Pool::MAX_SIZE,
        seeds = [b"pool", usdc_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init, payer = authority,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
        token::mint      = usdc_mint,
        token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA that will own the vault
    #[account(seeds = [b"vault-auth", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        constraint = lp_token_account.mint == pool.usdc_mint,
        constraint = lp_token_account.owner == lp.key())]
    pub lp_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        init, payer = creator,
        space = 8 + Market::MAX_SIZE,
        seeds = [b"market", match_id.as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrediction<'info> {
    pub oracle: Signer<'info>,

    #[account(mut,
        seeds = [b"market", market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.creator == oracle.key() @ TabulaError::OracleUnauthorized)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
#[instruction(outcome_idx: u8)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [b"market", market.match_id.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::MAX_SIZE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(mut, constraint = bettor_token_account.mint == pool.usdc_mint)]
    pub bettor_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleViaTxLine<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"market", market.match_id.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    /// CHECK: verified by TxLINE CPI
    #[account(mut)]
    pub stat_root: UncheckedAccount<'info>,

    /// CHECK: written by TxLINE CPI, deserialized manually
    #[account(mut)]
    pub receipt: UncheckedAccount<'info>,

    pub txline_program: Program<'info, TxlineMock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [b"market", market.match_id.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    #[account(mut,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump  = position.bump,
        constraint = position.owner == bettor.key())]
    pub position: Account<'info, Position>,

    #[account(mut, constraint = bettor_token_account.mint == pool.usdc_mint)]
    pub bettor_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for vault
    #[account(seeds = [b"vault-auth", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

#[account]
pub struct Pool {
    pub authority:        Pubkey,
    pub usdc_mint:        Pubkey,
    pub vault:            Pubkey,
    pub total_liquidity:  u64,
    pub fees_accrued:     u64,
    pub bump:             u8,
    pub vault_bump:       u8,
}
impl Pool { pub const MAX_SIZE: usize = 32*3 + 8*2 + 1*2; }

#[account]
pub struct Market {
    pub match_id:         [u8; 32],
    pub stat_type:        [u8; 16],
    pub outcome_count:    u8,
    pub bin_edges:        [u64; MAX_OUTCOMES + 1],
    pub probs:            [u64; MAX_OUTCOMES],
    pub q:                [i64; MAX_OUTCOMES],
    pub liquidity_b:      u64,
    pub status:           u8,
    pub winning_outcome:  u8,
    pub creator:          Pubkey,
    pub bump:             u8,
}
impl Market {
    pub const MAX_SIZE: usize =
        32 + 16 + 1
        + 8 * (MAX_OUTCOMES + 1)
        + 8 * MAX_OUTCOMES
        + 8 * MAX_OUTCOMES
        + 8 + 1 + 1 + 32 + 1;
}

#[account]
pub struct Position {
    pub owner:       Pubkey,
    pub market:      Pubkey,
    pub outcome_idx: u8,
    pub shares:      u64,
    pub usdc_in:     u64,
    pub claimed:     bool,
    pub bump:        u8,
}
impl Position { pub const MAX_SIZE: usize = 32*2 + 1 + 8 + 8 + 1 + 1; }

#[repr(u8)]
pub enum MarketStatus { Trading = 0, Resolved = 1, Cancelled = 2 }

// ---------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------

#[event] pub struct MarketCreated     { pub match_id: [u8;32], pub stat_type: [u8;16], pub outcome_count: u8 }
#[event] pub struct PredictionUpdated { pub match_id: [u8;32], pub new_b: u64 }
#[event] pub struct BetPlaced         { pub match_id: [u8;32], pub outcome_idx: u8, pub usdc_amount: u64, pub shares: u64, pub price_scaled: u64 }
#[event] pub struct MarketResolved    { pub match_id: [u8;32], pub stat_value: u64, pub winning_outcome: u8 }
#[event] pub struct WinningsClaimed   { pub owner: Pubkey, pub payout: u64 }

#[error_code]
pub enum TabulaError {
    #[msg("Amount must be > 0")]                       ZeroAmount,
    #[msg("Outcome count out of range (2..=10)")]      OutcomeCountOutOfRange,
    #[msg("bin_edges length must equal outcome_count + 1")] BinEdgeMismatch,
    #[msg("probs length must equal outcome_count")]    ProbCountMismatch,
    #[msg("Probabilities must sum to Q_SCALE")]        ProbabilitiesNotNormalized,
    #[msg("Liquidity parameter b must be > 0")]        ZeroLiquidityParam,
    #[msg("Outcome index out of range")]               OutcomeOutOfRange,
    #[msg("Cannot switch outcomes on existing position")] OutcomeMismatch,
    #[msg("Market is not in Trading state")]           NotTrading,
    #[msg("Market already settled")]                   AlreadySettled,
    #[msg("Market not resolved yet")]                  NotResolved,
    #[msg("Position already claimed")]                 AlreadyClaimed,
    #[msg("Stat type mismatch")]                       StatTypeMismatch,
    #[msg("TxLINE did not verify the stat")]           TxLineNotVerified,
    #[msg("Stat value fell outside all defined bins")] StatValueOutOfBins,
    #[msg("Share calculation underflow")]              ShareCalcUnderflow,
    #[msg("Only the market oracle may update predictions")] OracleUnauthorized,
}
