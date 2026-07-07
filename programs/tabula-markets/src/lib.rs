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
//!     (d) the receipt is fresh (< MAX_RECEIPT_AGE_SEC old),
//!     (e) attestation is one-shot and bound to (pool, market).
//!
//! Fixed-point convention: probabilities and `q`/`b` in Q_SCALE = 1_000_000.
//!
//! Trust notes (see SECURITY.md):
//! - `real-txline` still trusts the keeper (`settlement_oracle`) to have
//!   validated TxLINE off-chain; there is no on-chain Merkle/TxODDS CPI yet.
//! - Share pricing is fixed-odds at the oracle marginal price with MIN_PROB
//!   and liability caps — not a full LMSR cost function.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[cfg(feature = "mock-txline")]
use txline_mock::cpi::accounts::ValidateStat as TxLineValidateStatAccounts;
#[cfg(feature = "mock-txline")]
use txline_mock::program::TxlineMock;
#[cfg(feature = "mock-txline")]
use txline_mock::{self, StatReceipt as MockStatReceipt, StatRoot as MockStatRoot};

declare_id!("GZ6F2Q5DWQopyxcyTQk7Jko58Fc9jPdEdGdfiSZS7Z9T");

pub const Q_SCALE: u64        = 1_000_000;
pub const MAX_OUTCOMES: usize = 10;
/// Bin edges are one past the last outcome (`MAX_OUTCOMES + 1`).
pub const MAX_BIN_EDGES: usize = 11;
pub const FEE_BPS: u16        = 200;      // 2% spread routed to LP treasury
pub const SETTLE_FEE_BPS: u16 = 50;       // 0.5% off net winnings on payout

/// Minimum non-zero per-outcome probability (0.1% of Q_SCALE).
/// Caps max shares-per-USDC at ~Q_SCALE/MIN_PROB (~1000×) before fees.
pub const MIN_PROB: u64 = 1_000;

/// Per-market max payout liability ceiling (raw USDC base units, 6 decimals).
/// Tracks outstanding shares (claim pays $1/share), not stake-in.
pub const MAX_MARKET_EXPOSURE: u64 = 1_000_000_000_000; // 1M USDC

/// Reject settlement receipts older than this. Guards against replay of
/// stale keeper-signed receipts on the real-txline path.
pub const MAX_RECEIPT_AGE_SEC: i64 = 900; // 15 minutes

#[program]
pub mod tabula_markets {
    use super::*;

    // ---------------------------------------------------------------
    // Global config (gates pool creation)
    // ---------------------------------------------------------------

    /// One-shot: first deployer becomes admin. Subsequent calls fail (init).
    pub fn initialize_global(ctx: Context<InitializeGlobal>) -> Result<()> {
        let g = &mut ctx.accounts.global_config;
        g.admin = ctx.accounts.admin.key();
        g.bump  = ctx.bumps.global_config;
        emit!(GlobalInitialized { admin: g.admin });
        Ok(())
    }

    // ---------------------------------------------------------------
    // Pool lifecycle
    // ---------------------------------------------------------------

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        oracle_authority: Pubkey,
        settlement_oracle: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.global_config.admin,
            TabulaError::AdminUnauthorized
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority         = ctx.accounts.admin.key();
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

        let creator = ctx.accounts.creator.key();
        require!(
            creator == ctx.accounts.pool.authority
                || creator == ctx.accounts.pool.oracle_authority,
            TabulaError::CreateMarketUnauthorized
        );

        require!(
            (outcome_count as usize) <= MAX_OUTCOMES && outcome_count >= 2,
            TabulaError::OutcomeCountOutOfRange
        );
        let expected_edges = (outcome_count as usize)
            .checked_add(1)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        require!(bin_edges.len() == expected_edges, TabulaError::BinEdgeMismatch);
        require!(
            initial_probs.len() == outcome_count as usize,
            TabulaError::ProbCountMismatch
        );
        require!(liquidity_b > 0, TabulaError::ZeroLiquidityParam);

        for w in bin_edges.windows(2) {
            require!(w[0] < w[1], TabulaError::BinEdgesNotMonotonic);
        }

        validate_probs(&initial_probs, outcome_count)?;

        let market = &mut ctx.accounts.market;
        market.pool            = ctx.accounts.pool.key();
        market.match_id        = match_id;
        market.stat_type       = stat_type;
        market.outcome_count   = outcome_count;
        market.bin_edges       = [0u64; MAX_BIN_EDGES];
        market.probs           = [0u64; MAX_OUTCOMES];
        market.q               = [0i64; MAX_OUTCOMES];
        market.liquidity_b     = liquidity_b;
        market.status          = MarketStatus::Trading as u8;
        market.winning_outcome = u8::MAX;
        market.creator         = creator;
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

        validate_probs(&new_probs, market.outcome_count)?;

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

        let p_i = market.probs[outcome_idx as usize];
        require!(p_i >= MIN_PROB, TabulaError::OutcomeZeroProb);

        // marginal price = p_i * (1 + fee_bps/10_000), all in Q_SCALE.
        let numer = (p_i as u128)
            .checked_mul(10_000u128 + FEE_BPS as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        let price_scaled = numer
            .checked_div(10_000u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))? as u64;
        require!(price_scaled > 0, TabulaError::ShareCalcUnderflow);

        // shares = usdc / price  (price in Q_SCALE); claim pays shares as USDC.
        let shares_u128 = (usdc_amount as u128)
            .checked_mul(Q_SCALE as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?
            .checked_div(price_scaled as u128)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        let shares: u64 = u64::try_from(shares_u128)
            .map_err(|_| error!(TabulaError::ArithmeticOverflow))?;
        require!(shares > 0, TabulaError::ShareCalcUnderflow);

        // Liability = outstanding shares on this outcome (max payout if it wins).
        let idx = outcome_idx as usize;
        let prior = market.q[idx].max(0) as u64;
        let outcome_liability = prior
            .checked_add(shares)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        require!(
            outcome_liability <= MAX_MARKET_EXPOSURE,
            TabulaError::ExposureCapExceeded
        );
        // Vault must cover the new max payout on this outcome.
        require!(
            outcome_liability <= ctx.accounts.vault.amount.saturating_add(usdc_amount),
            TabulaError::InsufficientVaultLiquidity
        );

        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.bettor_token_account.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.bettor.to_account_info(),
            },
        );
        token::transfer(cpi, usdc_amount)?;

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

        market.q[idx] = market.q[idx]
            .checked_add(shares as i64)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        market.exposure = max_outcome_liability(market);

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
        require_keys_eq!(
            ctx.accounts.settlement_oracle.key(),
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );

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

        // Seeds bind the receipt PDA address above. Owner is enforced here
        // (receipt may be created by the CPI via init_if_needed, so it stays
        // UncheckedAccount and cannot be typed as Account before CPI).
        require_keys_eq!(*ctx.accounts.receipt.owner, txline_mock::ID);
        let receipt_data = ctx.accounts.receipt.try_borrow_data()?;
        let account = MockStatReceipt::try_deserialize(&mut &receipt_data[..])?;
        require!(account.verified, TabulaError::TxLineNotVerified);
        require!(account.stat_type == stat_type, TabulaError::StatTypeMismatch);
        require!(account.match_id == market.match_id, TabulaError::MatchIdMismatch);
        let stat_value = account.stat_value;
        drop(receipt_data);

        resolve_market(market, stat_value)
    }

    // ---------------------------------------------------------------
    // Settlement — real / keeper-attested backend.
    // Distinct ix name from mock `settle_via_txline` (Anchor #[program]
    // cannot emit two variants of the same name with different signatures).
    // Residual risk (F-004): trusts settlement_oracle; no on-chain TxODDS CPI.
    // ---------------------------------------------------------------
    pub fn settle_via_tx_line_real(
        ctx: Context<SettleViaTxLineReal>,
        stat_value: u64,
        _txodds_fixture_id: u64,
        _txodds_seq: u32,
        _txodds_stat_key: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);

        // Signer must be the pool's settlement oracle (keeper) which has
        // executed `validateStat.view()` against the real TxODDS program.
        // Residual risk (F-004): a malicious/compromised keeper can still
        // post a false attestation — there is no on-chain TxODDS CPI yet.
        require_keys_eq!(
            ctx.accounts.settlement_oracle.key(),
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Trading as u8, TabulaError::AlreadySettled);

        let att = &mut ctx.accounts.attestation;
        require!(!att.used, TabulaError::AttestationAlreadyUsed);

        let now = Clock::get()?.unix_timestamp;
        let age = now.checked_sub(att.attested_at).unwrap_or(i64::MAX);
        require!(age >= 0 && age <= MAX_RECEIPT_AGE_SEC, TabulaError::AttestationExpired);
        require!(att.match_id == market.match_id, TabulaError::MatchIdMismatch);
        require!(att.stat_type == market.stat_type, TabulaError::StatTypeMismatch);
        require!(att.stat_value == stat_value, TabulaError::StatValueMismatch);
        require_keys_eq!(
            att.settlement_oracle,
            ctx.accounts.pool.settlement_oracle,
            TabulaError::OracleUnauthorized
        );

        att.used = true;
        resolve_market(market, stat_value)
    }

    // ---------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        require!(!ctx.accounts.pool.paused, TabulaError::PoolPaused);
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, TabulaError::AlreadyClaimed);
        require_keys_eq!(position.owner, ctx.accounts.bettor.key(), TabulaError::PositionOwnerMismatch);

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Resolved as u8, TabulaError::NotResolved);

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

        // Debit liability before transfer.
        let idx = position.outcome_idx as usize;
        if idx < market.outcome_count as usize && position.shares > 0 {
            market.q[idx] = market.q[idx].saturating_sub(position.shares as i64);
            market.exposure = max_outcome_liability(market);
        }

        position.claimed = true;

        if payout > 0 {
            require!(
                ctx.accounts.vault.amount >= payout,
                TabulaError::InsufficientVaultLiquidity
            );
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
    // Keeper posts a one-shot attestation bound to (pool, market).
    // ---------------------------------------------------------------
    pub fn post_tx_line_attestation(
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
        require!(
            ctx.accounts.market.status == MarketStatus::Trading as u8,
            TabulaError::NotTrading
        );
        require!(ctx.accounts.market.match_id == match_id, TabulaError::MatchIdMismatch);
        require!(ctx.accounts.market.stat_type == stat_type, TabulaError::StatTypeMismatch);

        let att = &mut ctx.accounts.attestation;
        att.match_id           = match_id;
        att.stat_type          = stat_type;
        att.stat_value         = stat_value;
        att.txodds_fixture_id  = txodds_fixture_id;
        att.txodds_seq         = txodds_seq;
        att.txodds_stat_key    = txodds_stat_key;
        att.settlement_oracle  = ctx.accounts.settlement_oracle.key();
        att.attested_at        = Clock::get()?.unix_timestamp;
        att.used               = false;
        att.bump               = ctx.bumps.attestation;
        emit!(AttestationPosted { match_id, stat_value });
        Ok(())
    }
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

/// Non-zero probs must be >= MIN_PROB; sum must be ≈ Q_SCALE.
fn validate_probs(probs: &[u64], outcome_count: u8) -> Result<()> {
    require!(
        probs.len() == outcome_count as usize,
        TabulaError::ProbCountMismatch
    );
    let sum: u64 = probs
        .iter()
        .try_fold(0u64, |acc, p| acc.checked_add(*p))
        .ok_or(error!(TabulaError::ArithmeticOverflow))?;
    require!(
        sum.abs_diff(Q_SCALE) <= (outcome_count as u64),
        TabulaError::ProbabilitiesNotNormalized
    );
    for p in probs {
        require!(*p == 0 || *p >= MIN_PROB, TabulaError::ProbBelowMinimum);
    }
    // At least one tradable outcome.
    require!(probs.iter().any(|p| *p >= MIN_PROB), TabulaError::ProbBelowMinimum);
    Ok(())
}

fn max_outcome_liability(market: &Market) -> u64 {
    let mut m = 0u64;
    for i in 0..market.outcome_count as usize {
        let s = market.q[i].max(0) as u64;
        if s > m {
            m = s;
        }
    }
    m
}

fn resolve_market(market: &mut Account<Market>, stat_value: u64) -> Result<()> {
    let mut winning: Option<u8> = None;
    for i in 0..market.outcome_count as usize {
        let lo = market.bin_edges[i];
        let hi_idx = i
            .checked_add(1)
            .ok_or(error!(TabulaError::ArithmeticOverflow))?;
        let hi = market.bin_edges[hi_idx];
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
pub struct InitializeGlobal<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GlobalConfig::SPACE,
        seeds = [b"global"],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global"],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init, payer = admin,
        space = Pool::SPACE,
        seeds = [b"pool", usdc_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init, payer = admin,
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
        space = Market::SPACE,
        seeds = [b"market", pool.key().as_ref(), match_id.as_ref()],
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
        seeds = [b"market", pool.key().as_ref(), market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        seeds = [b"market", pool.key().as_ref(), market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = Position::SPACE,
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

    pub settlement_oracle: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        seeds = [b"market", pool.key().as_ref(), market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,

    /// TxLINE-owned stat root PDA (published before settle).
    #[account(
        seeds = [b"stat-root", market.match_id.as_ref()],
        bump = stat_root.bump,
        seeds::program = txline_program.key(),
    )]
    pub stat_root: Account<'info, MockStatRoot>,

    /// CHECK: PDA address bound to txline-mock; may be uninitialized until
    /// the validate_stat CPI (`init_if_needed`). Owner + data checked after CPI.
    #[account(
        mut,
        seeds = [b"receipt", stat_root.key().as_ref(), market.match_id.as_ref()],
        bump,
        seeds::program = txline_program.key(),
    )]
    pub receipt: UncheckedAccount<'info>,

    pub txline_program: Program<'info, TxlineMock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleViaTxLineReal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub settlement_oracle: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut,
        seeds = [b"market", pool.key().as_ref(), market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,

    #[account(mut,
        seeds = [b"attestation", pool.key().as_ref(), market.key().as_ref()],
        bump = attestation.bump,
        constraint = !attestation.used @ TabulaError::AttestationAlreadyUsed)]
    pub attestation: Account<'info, TxLineAttestation>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct PostTxLineAttestation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub settlement_oracle: Signer<'info>,

    #[account(seeds = [b"pool", pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [b"market", pool.key().as_ref(), match_id.as_ref()],
        bump = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
    pub market: Account<'info, Market>,

    // One-shot: `init` (not init_if_needed) so attestation cannot be rewritten.
    #[account(
        init,
        payer = payer,
        space = TxLineAttestation::SPACE,
        seeds = [b"attestation", pool.key().as_ref(), market.key().as_ref()],
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

    #[account(mut,
        seeds = [b"market", pool.key().as_ref(), market.match_id.as_ref()],
        bump  = market.bump,
        constraint = market.pool == pool.key() @ TabulaError::MarketPoolMismatch)]
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
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub bump:  u8,
}
impl GlobalConfig {
    /// Precomputed account space (discriminator + data) for solana-vscode.
    pub const SPACE: usize = 41;
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority:         Pubkey,
    pub oracle_authority:  Pubkey,   // signs update_prediction
    pub settlement_oracle: Pubkey,   // signs settle / post_tx_line_attestation
    pub usdc_mint:         Pubkey,
    pub vault:             Pubkey,
    pub total_liquidity:   u64,
    pub fees_accrued:      u64,
    pub paused:            bool,
    pub bump:              u8,
    pub vault_bump:        u8,
}
impl Pool {
    pub const SPACE: usize = 187;
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub pool:             Pubkey,
    pub match_id:         [u8; 32],
    pub stat_type:        [u8; 16],
    pub outcome_count:    u8,
    pub bin_edges:        [u64; MAX_BIN_EDGES],
    pub probs:            [u64; MAX_OUTCOMES],
    pub q:                [i64; MAX_OUTCOMES],
    pub liquidity_b:      u64,
    pub status:           u8,
    pub winning_outcome:  u8,
    pub creator:          Pubkey,
    /// Max outstanding payout liability (shares) across outcomes.
    pub exposure:         u64,
    pub bump:             u8,
}
impl Market {
    pub const SPACE: usize = 388;
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner:       Pubkey,
    pub market:      Pubkey,
    pub outcome_idx: u8,
    pub shares:      u64,
    pub usdc_in:     u64,
    pub claimed:     bool,
    pub bump:        u8,
}
impl Position {
    pub const SPACE: usize = 91;
}

#[account]
#[derive(InitSpace)]
pub struct TxLineAttestation {
    pub match_id:           [u8; 32],
    pub stat_type:          [u8; 16],
    pub stat_value:         u64,
    pub txodds_fixture_id:  u64,
    pub txodds_seq:         u32,
    pub txodds_stat_key:    u16,
    pub settlement_oracle:  Pubkey,
    pub attested_at:        i64,
    pub used:               bool,
    pub bump:               u8,
}
impl TxLineAttestation {
    pub const SPACE: usize = 120;
}

#[repr(u8)]
pub enum MarketStatus { Trading = 0, Resolved = 1, Cancelled = 2 }

// ---------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------

#[event] pub struct GlobalInitialized { pub admin: Pubkey }
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
    #[msg("Non-zero probability below MIN_PROB")]             ProbBelowMinimum,
    #[msg("Liquidity parameter b must be > 0")]               ZeroLiquidityParam,
    #[msg("Outcome index out of range")]                      OutcomeOutOfRange,
    #[msg("Outcome probability is zero or below MIN_PROB")]   OutcomeZeroProb,
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
    #[msg("Only pool authority or oracle may create markets")] CreateMarketUnauthorized,
    #[msg("Market is not bound to this pool")]                MarketPoolMismatch,
    #[msg("Per-market payout liability cap exceeded")]        ExposureCapExceeded,
    #[msg("Vault has insufficient liquidity for liability")]  InsufficientVaultLiquidity,
    #[msg("Arithmetic overflow")]                             ArithmeticOverflow,
    #[msg("Pool is paused")]                                  PoolPaused,
    #[msg("TxLINE attestation expired")]                      AttestationExpired,
    #[msg("TxLINE attestation already consumed")]             AttestationAlreadyUsed,
}
