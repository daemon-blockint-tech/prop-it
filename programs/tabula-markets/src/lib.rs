//! tabula-markets
//!
//! On-chain half of TabulaMarkets: a dynamic-LMSR prop-bet AMM whose price
//! curve is steered by an off-chain TabFM ensemble oracle and whose
//! settlement is proven trustlessly via TxLINE.
//!
//! Two settlement backends are selectable via Cargo features:
//!
//!   * `mock-txline` (default in dev) — CPIs into the local `txline-mock`
//!     program that ships alongside this crate. Deterministic Merkle
//!     verification, self-contained validator, ideal for tests and demos.
//!   * `real-txline` (production) — expects the caller to supply a fully
//!     verified `StatReceipt`-shaped account that was written by the keeper
//!     after a successful `validateStat.view()` roundtrip against the real
//!     TxODDS `txoracle` program on mainnet/devnet. We still verify:
//!     (a) receipt is signed by the configured `settlement_oracle` key,
//!     (b) receipt.match_id matches the market,
//!     (c) receipt.stat_type matches the market,
//!     (d) the receipt is fresh (< MAX_RECEIPT_AGE_SEC old).
//!
//! Fixed-point convention: probabilities and `q`/`b` in Q_SCALE = 1_000_000.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[cfg(feature = "mock-txline")]
use txline_mock::cpi::accounts::ValidateStat as TxLineValidateStatAccounts;
#[cfg(feature = "mock-txline")]
use txline_mock::program::TxlineMock;
#[cfg(feature = "mock-txline")]
use txline_mock::{self, StatReceipt as MockStatReceipt};

declare_id!("TabuLA11111111111111111111111111111111111111");

pub const Q_SCALE: u64        = 1_000_000;
pub const MAX_OUTCOMES: usize = 10;
pub const FEE_BPS: u16        = 200;      // 2% spread routed to LP treasury
pub const SETTLE_FEE_BPS: u16 = 50;       // 0.5% off net winnings on payout

/// Per-market USDC exposure ceiling (in raw USDC base units, 6 decimals).
/// Prevents a runaway market from draining the shared LP vault.
pub const MAX_MARKET_EXPOSURE: u64 = 1_000_000_000_000; // 1M USDC

/// Reject settlement receipts older than this. Guards against replay of
/// stale keeper-signed receipts on the real-txline path.
pub const MAX_RECEIPT_AGE_SEC: i64 = 15 * 60;

#[program]
pub mod tabula_markets {
    use super::*;

    // ---------------------------------------------------------------
    // Pool lifecycle
    // ---------------------------------------------------------------

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        oracle_authority: Pubkey,
        settlement_oracle: Pubkey,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority         = ctx.accounts.authority.key();
        pool.oracle_authority  = oracle_authority;
        pool.settlement_oracle = settlement_oracle;
        pool.usdc_mint         = ctx.accounts.usdc_mint.key();
        pool.vault             = ctx.accounts.vault.key();
        pool.total_liquidity   = 0;
        pool.fees_accrued      = 0;
        pool.paused            = false;
        pool.bump              = ctx.bumps.pool;
        pool.vault_bump        = ctx.bumps.vault;
        Ok(())
    }

    /// Governance-only kill switch. Blocks new bets and settlements when set.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.pool.authority,
            TabulaError::AdminUnauthorized
        );
        ctx.accounts.pool.paused = paused;
        emit!(PoolPauseToggled { paused });
        Ok(())
    }

    pub fn rotate_oracle(
        ctx: Context<AdminOnly>,
        new_prediction_oracle: Pubkey,
        new_settlement_oracle: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.pool.authority,
            TabulaError::AdminUnauthorized
        );
        ctx.accounts.pool.oracle_authority  = new_prediction_oracle;
        ctx.accounts.pool.settlement_oracle = new_settlement_oracle;
        emit!(OracleRotated { new_prediction_oracle, new_settlement_oracle });
        Ok(())
    }

    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);
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
        pool.total_liquidity = pool
            .total_liquidity
            .checked_add(amount)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
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
        bin_edges: Vec<u64>,
        initial_probs: Vec<u64>,
        liquidity_b: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);
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

        // Enforce monotone bin edges (protects settlement bin-search logic).
        for w in bin_edges.windows(2) {
            require!(w[0] < w[1], TabulaError::BinEdgesNotMonotonic);
        }

        let sum: u64 = initial_probs
            .iter()
            .try_fold(0u64, |acc, p| acc.checked_add(*p))
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        require!(
            sum.abs_diff(Q_SCALE) <= (outcome_count as u64),
            TabulaError::ProbabilitiesNotNormalized
        );

        let market = &mut ctx.accounts.market;
        market.match_id        = match_id;
        market.stat_type       = stat_type;
        market.outcome_count   = outcome_count;
        market.bin_edges       = [0u64; MAX_OUTCOMES + 1];
        market.probs           = [0u64; MAX_OUTCOMES];
        market.q               = [0i64; MAX_OUTCOMES];
        market.liquidity_b     = liquidity_b;
        market.status          = MarketStatus::Trading as u8;
        market.winning_outcome = u8::MAX;
        market.creator         = ctx.accounts.creator.key();
        market.exposure        = 0;
        market.bump            = ctx.bumps.market;

        for (i, e) in bin_edges.iter().enumerate() { market.bin_edges[i] = *e; }
        for (i, p) in initial_probs.iter().enumerate() { market.probs[i] = *p; }

        emit!(MarketCreated { match_id, stat_type, outcome_count });
        Ok(())
    }

    /// Oracle-only: push a new ensemble prediction and adjust `b`.
    /// Signer must equal `pool.oracle_authority` (rotatable via admin).
    pub fn update_prediction(
        ctx: Context<UpdatePrediction>,
        new_probs: Vec<u64>,
        new_b: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.oracle.key(),
            ctx.accounts.pool.oracle_authority,
            TabulaError::OracleUnauthorized
        );
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::NotTrading);
        require!(
            new_probs.len() == market.outcome_count as usize,
            TabulaError::ProbCountMismatch
        );
        require!(new_b > 0, TabulaError::ZeroLiquidityParam);

        let sum: u64 = new_probs
            .iter()
            .try_fold(0u64, |acc, p| acc.checked_add(*p))
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        require!(
            sum.abs_diff(Q_SCALE) <= (market.outcome_count as u64),
            TabulaError::ProbabilitiesNotNormalized
        );

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

    pub fn place_bet(
        ctx: Context<PlaceBet>,
        outcome_idx: u8,
        usdc_amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);
        require!(usdc_amount > 0, TabulaError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::NotTrading);
        require!(
            (outcome_idx as usize) < market.outcome_count as usize,
            TabulaError::OutcomeOutOfRange
        );

        // ---- LP exposure cap ---------------------------------------
        let new_exposure = market
            .exposure
            .checked_add(usdc_amount)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        require!(new_exposure <= MAX_MARKET_EXPOSURE, TabulaError::ExposureCapExceeded);
        market.exposure = new_exposure;

        let p_i = market.probs[outcome_idx as usize];
        require!(p_i > 0, TabulaError::OutcomeZeroProb);

        // marginal price = p_i * (1 + fee_bps/10_000), all in Q_SCALE.
        let numer = (p_i as u128)
            .checked_mul(10_000u128 + FEE_BPS as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        let price_scaled = numer
            .checked_div(10_000u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))? as u64;
        require!(price_scaled > 0, TabulaError::ShareCalcUnderflow);

        // shares = usdc / price  (price in Q_SCALE)
        let shares_u128 = (usdc_amount as u128)
            .checked_mul(Q_SCALE as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?
            .checked_div(price_scaled as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        let shares: u64 = u64::try_from(shares_u128)
            .map_err(|_| error!(TabulaError::ArithmeticOverflow))?;
        require!(shares > 0, TabulaError::ShareCalcUnderflow);

        // Transfer USDC bettor -> vault (effect BEFORE state mutation would be
        // ideal, but Solana runtime is single-threaded and there is no
        // reentrancy risk on token::transfer — the token program is trusted).
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
            require!(!position.claimed, TabulaError::AlreadyClaimed);
        }
        position.shares  = position
            .shares
            .checked_add(shares)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        position.usdc_in = position
            .usdc_in
            .checked_add(usdc_amount)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        position.claimed = false;

        market.q[outcome_idx as usize] = market.q[outcome_idx as usize]
            .checked_add(shares as i64)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;

        let pool = &mut ctx.accounts.pool;
        let fee = usdc_amount
            .checked_mul(FEE_BPS as u64)
            .and_then(|v| v.checked_div(10_000u64))
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        pool.fees_accrued = pool
            .fees_accrued
            .checked_add(fee)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;

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
    // Settlement — mock backend
    // ---------------------------------------------------------------
    #[cfg(feature = "mock-txline")]
    pub fn settle_via_txline(
        ctx: Context<SettleViaTxLineMock>,
        stat_type: [u8; 16],
        stat_value: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::AlreadySettled);
        require!(market.stat_type == stat_type, TabulaError::StatTypeMismatch);

        let cpi_program  = ctx.accounts.txline_program.to_account_info();
        let cpi_accounts = TxLineValidateStatAccounts {
            payer:          ctx.accounts.payer.to_account_info(),
            stat_root:      ctx.accounts.stat_root.to_account_info(),
            receipt:        ctx.accounts.receipt.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        txline_mock::cpi::validate_stat(cpi_ctx, stat_type, stat_value, proof)?;

        let receipt_data = ctx.accounts.receipt.try_borrow_data()?;
        let account = MockStatReceipt::try_deserialize(&mut &receipt_data[..])?;
        require!(account.verified, TabulaError::TxLineNotVerified);
        require!(account.stat_type == stat_type, TabulaError::StatTypeMismatch);
        require!(account.match_id == market.match_id, TabulaError::MatchIdMismatch);
        drop(receipt_data);

        resolve_market(market, account.stat_value)
    }

    // ---------------------------------------------------------------
    // Settlement — real backend
    // ---------------------------------------------------------------
    #[cfg(feature = "real-txline")]
    pub fn settle_via_txline(
        ctx: Context<SettleViaTxLineReal>,
        stat_value: u64,
        _txodds_fixture_id: u64,
        _txodds_seq: u32,
        _txodds_stat_key: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);

        // Signer must be the pool's settlement oracle (keeper) which has
        // executed `validateStat.view()` against the real TxODDS program.
        require_keys_eq!(
            ctx.accounts.settlement_oracle.key(),
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::AlreadySettled);

        // Freshness check: settlement must happen close to when the keeper
        // observed the on-chain Merkle validation.
        let now = Clock::get()?.unix_timestamp;
        let age = now.checked_sub(ctx.accounts.attestation.attested_at).unwrap_or(i64::MAX);
        require!(age >= 0 && age <= MAX_RECEIPT_AGE_SEC, TabulaError::AttestationExpired);
        require!(ctx.accounts.attestation.match_id == market.match_id, TabulaError::MatchIdMismatch);
        require!(ctx.accounts.attestation.stat_type == market.stat_type, TabulaError::StatTypeMismatch);
        require!(ctx.accounts.attestation.stat_value == stat_value, TabulaError::StatValueMismatch);
        require_keys_eq!(
            ctx.accounts.attestation.settlement_oracle,
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );

        resolve_market(market, stat_value)
    }

    // ---------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);
        let market   = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        require!(market.status == MarketStatus::Resolved as u8, TabulaError::NotResolved);
        require!(!position.claimed, TabulaError::AlreadyClaimed);
        require_keys_eq!(position.owner, ctx.accounts.bettor.key(), TabulaError::PositionOwnerMismatch);

        let payout = if position.outcome_idx == market.winning_outcome {
            let gross = position.shares;
            let net_winnings = gross.saturating_sub(position.usdc_in);
            let fee = net_winnings
                .checked_mul(SETTLE_FEE_BPS as u64)
                .and_then(|v| v.checked_div(10_000u64))
                .ok_or(error!(TabulaError::ArithmeticOverflow))?;
            gross.saturating_sub(fee)
        } else {
            0
        };

        // Mark BEFORE transfer to eliminate any theoretical reentrancy on
        // token_program (defense in depth — the SPL token program is trusted
        // but the pattern is worth keeping).
        position.claimed = true;

        if payout > 0 {
            let pool_key = ctx.accounts.pool.key();
            let seeds: &[&[u8]] = &[b"vault-auth", pool_key.as_ref(), &[ctx.bumps.vault_authority]];
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

    // ---------------------------------------------------------------
    // Real-txline: keeper posts a signed attestation account describing the
    // outcome of a successful `validateStat` on the TxODDS program.
    // ---------------------------------------------------------------
    #[cfg(feature = "real-txline")]
    pub fn post_txline_attestation(
        ctx: Context<PostTxLineAttestation>,
        match_id: [u8; 32],
        stat_type: [u8; 16],
        stat_value: u64,
        txodds_fixture_id: u64,
        txodds_seq: u32,
        txodds_stat_key: u16,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.settlement_oracle.key(),
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );
        let att = &mut ctx.accounts.attestation;
        att.match_id           = match_id;
        att.stat_type          = stat_type;
        att.stat_value         = stat_value;
        att.txodds_fixture_id  = txodds_fixture_id;
        att.txodds_seq         = txodds_seq;
        att.txodds_stat_key    = txodds_stat_key;
        att.settlement_oracle  = ctx.accounts.settlement_oracle.key();
        att.attested_at        = Clock::get()?.unix_timestamp;
        att.bump               = ctx.bumps.attestation;
        emit!(AttestationPosted { match_id, stat_value });
        Ok(())
    }
}

// ------------------------------------------------------------------
// Shared settlement logic
// ------------------------------------------------------------------
fn resolve_market(market: &mut Account<Market>, stat_value: u64) -> Result<()> {
    let mut winning: Option<u8> = None;
    for i in 0..market.outcome_count as usize {
        let lo = market.bin_edges[i];
        let hi = market.bin_edges[i + 1];
        if stat_value >= lo && stat_value < hi {
            winning = Some(i as u8);
            break;
        }
    }
    let win_idx = winning.ok_or(error!(TabulaError::StatValueOutOfBins))?;
    market.winning_outcome = win_idx;
    market.status          = MarketStatus::Resolved as u8;

    emit!(MarketResolved {
        match_id:        market.match_id,
        stat_value,
        winning_outcome: win_idx,
    });
    Ok(())
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

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        constraint = lp_token_account.mint  == pool.usdc_mint,
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

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        seeds = [b"market", market.match_id.as_ref()],
        bump  = market.bump)]
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

    #[account(mut,
        constraint = bettor_token_account.mint  == pool.usdc_mint,
        constraint = bettor_token_account.owner == bettor.key())]
    pub bettor_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "mock-txline")]
#[derive(Accounts)]
pub struct SettleViaTxLineMock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

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

#[cfg(feature = "real-txline")]
#[derive(Accounts)]
pub struct SettleViaTxLineReal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub settlement_oracle: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [b"market", market.match_id.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [b"attestation", market.key().as_ref()],
        bump = attestation.bump)]
    pub attestation: Account<'info, TxLineAttestation>,
}

#[cfg(feature = "real-txline")]
#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct PostTxLineAttestation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub settlement_oracle: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [b"market", match_id.as_ref()], bump)]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + TxLineAttestation::MAX_SIZE,
        seeds = [b"attestation", market.key().as_ref()],
        bump,
    )]
    pub attestation: Account<'info, TxLineAttestation>,

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

    #[account(mut,
        constraint = bettor_token_account.mint  == pool.usdc_mint,
        constraint = bettor_token_account.owner == bettor.key())]
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
    pub authority:         Pubkey,
    pub oracle_authority:  Pubkey,   // signs update_prediction
    pub settlement_oracle: Pubkey,   // signs settle / post_txline_attestation
    pub usdc_mint:         Pubkey,
    pub vault:             Pubkey,
    pub total_liquidity:   u64,
    pub fees_accrued:      u64,
    pub paused:            bool,
    pub bump:              u8,
    pub vault_bump:        u8,
}
impl Pool { pub const MAX_SIZE: usize = 32*5 + 8*2 + 1*3; }

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
    pub exposure:         u64,
    pub bump:             u8,
}
impl Market {
    pub const MAX_SIZE: usize =
        32 + 16 + 1
        + 8 * (MAX_OUTCOMES + 1)
        + 8 * MAX_OUTCOMES
        + 8 * MAX_OUTCOMES
        + 8 + 1 + 1 + 32 + 8 + 1;
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

#[account]
pub struct TxLineAttestation {
    pub match_id:           [u8; 32],
    pub stat_type:          [u8; 16],
    pub stat_value:         u64,
    pub txodds_fixture_id:  u64,
    pub txodds_seq:         u32,
    pub txodds_stat_key:    u16,
    pub settlement_oracle:  Pubkey,
    pub attested_at:        i64,
    pub bump:               u8,
}
impl TxLineAttestation {
    pub const MAX_SIZE: usize = 32 + 16 + 8 + 8 + 4 + 2 + 32 + 8 + 1;
}

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
#[event] pub struct PoolPauseToggled  { pub paused: bool }
#[event] pub struct OracleRotated     { pub new_prediction_oracle: Pubkey, pub new_settlement_oracle: Pubkey }
#[event] pub struct AttestationPosted { pub match_id: [u8;32], pub stat_value: u64 }

#[error_code]
pub enum TabulaError {
    #[msg("Amount must be > 0")]                              ZeroAmount,
    #[msg("Outcome count out of range (2..=10)")]             OutcomeCountOutOfRange,
    #[msg("bin_edges length must equal outcome_count + 1")]   BinEdgeMismatch,
    #[msg("bin_edges must be strictly monotonic ascending")]  BinEdgesNotMonotonic,
    #[msg("probs length must equal outcome_count")]           ProbCountMismatch,
    #[msg("Probabilities must sum to Q_SCALE")]               ProbabilitiesNotNormalized,
    #[msg("Liquidity parameter b must be > 0")]               ZeroLiquidityParam,
    #[msg("Outcome index out of range")]                      OutcomeOutOfRange,
    #[msg("Outcome probability is zero")]                     OutcomeZeroProb,
    #[msg("Cannot switch outcomes on existing position")]     OutcomeMismatch,
    #[msg("Market is not in Trading state")]                  NotTrading,
    #[msg("Market already settled")]                          AlreadySettled,
    #[msg("Market not resolved yet")]                         NotResolved,
    #[msg("Position already claimed")]                        AlreadyClaimed,
    #[msg("Position owner mismatch")]                         PositionOwnerMismatch,
    #[msg("Stat type mismatch")]                              StatTypeMismatch,
    #[msg("Stat value mismatch vs attestation")]              StatValueMismatch,
    #[msg("Match id mismatch vs receipt/attestation")]        MatchIdMismatch,
    #[msg("TxLINE did not verify the stat")]                  TxLineNotVerified,
    #[msg("Stat value fell outside all defined bins")]        StatValueOutOfBins,
    #[msg("Share calculation underflow")]                     ShareCalcUnderflow,
    #[msg("Only the market oracle may update predictions")]   OracleUnauthorized,
    #[msg("Only the pool authority may perform this action")] AdminUnauthorized,
    #[msg("Per-market USDC exposure cap exceeded")]           ExposureCapExceeded,
    #[msg("Arithmetic overflow")]                             ArithmeticOverflow,
    #[msg("Pool is paused")]                                  PoolPaused,
    #[msg("TxLINE attestation expired")]                      AttestationExpired,
}
