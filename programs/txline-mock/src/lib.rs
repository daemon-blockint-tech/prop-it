//! txline-mock
//!
//! Local stand-in for the TxLINE on-chain program. In production, TabulaMarkets
//! would CPI into the real TxLINE program deployed by TxODDS. For hackathon
//! demos we ship this mock so the entire trustless-settlement flow can be run
//! on a local validator without any external dependency.
//!
//! Design mirrors the surface described in the TabulaMarkets architecture doc:
//!
//! * A one-shot `TxLineConfig` PDA that stores the sole authority allowed to
//!   publish Merkle roots.
//! * A `StatRoot` PDA that stores the Merkle root of a match's official stats,
//!   signed by that authority when a match reaches full-time.
//! * A `validate_stat` instruction that verifies a Merkle proof against the
//!   published root and — on success — writes the definitive stat value into
//!   a scratch account so the caller (via CPI) can read it back.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

declare_id!("9zs9jxdsjQigoKYpUuUYfBz5fdym3xXgdQa4twEjCYr");

#[program]
pub mod txline_mock {
    use super::*;

    /// One-shot: first caller becomes the sole TxLINE authority.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.bump      = ctx.bumps.config;
        emit!(ConfigInitialized { authority: config.authority });
        Ok(())
    }

    /// Called once by the configured TxLINE authority right after a match
    /// reaches full-time. Anchors the Merkle root of the official stats.
    pub fn publish_stat_root(
        ctx: Context<PublishStatRoot>,
        match_id: [u8; 32],
        merkle_root: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            TxLineError::Unauthorized
        );

        let root = &mut ctx.accounts.stat_root;
        root.match_id     = match_id;
        root.merkle_root  = merkle_root;
        root.authority    = ctx.accounts.authority.key();
        root.published_at = Clock::get()?.unix_timestamp;
        root.bump         = ctx.bumps.stat_root;

        emit!(StatRootPublished {
            match_id,
            merkle_root,
            authority: root.authority,
        });
        Ok(())
    }

    /// Verifies that `(stat_type, stat_value)` was included in the Merkle tree
    /// whose root was previously anchored via `publish_stat_root`. On success
    /// it writes the value into the `receipt` account so the CPI caller can
    /// consume it. Fails otherwise.
    pub fn validate_stat(
        ctx: Context<ValidateStat>,
        stat_type: [u8; 16],
        stat_value: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let root = &ctx.accounts.stat_root;

        // Leaf format: keccak256(stat_type || stat_value_le_bytes)
        let mut leaf_pre = Vec::with_capacity(16 + 8);
        leaf_pre.extend_from_slice(&stat_type);
        leaf_pre.extend_from_slice(&stat_value.to_le_bytes());
        let mut node = keccak::hash(&leaf_pre).to_bytes();

        for sibling in proof.iter() {
            // Sort-pair hashing so proofs are directionless.
            let (a, b) = if node <= *sibling {
                (node, *sibling)
            } else {
                (*sibling, node)
            };
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&a);
            buf[32..].copy_from_slice(&b);
            node = keccak::hash(&buf).to_bytes();
        }

        require!(node == root.merkle_root, TxLineError::InvalidProof);

        let receipt = &mut ctx.accounts.receipt;
        receipt.match_id   = root.match_id;
        receipt.stat_type  = stat_type;
        receipt.stat_value = stat_value;
        receipt.verified   = true;
        receipt.verified_at = Clock::get()?.unix_timestamp;

        emit!(StatValidated {
            match_id: root.match_id,
            stat_type,
            stat_value,
        });
        Ok(())
    }
}

// --------------------------------------------------------------------------
// Accounts
// --------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + TxLineConfig::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, TxLineConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct PublishStatRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, TxLineConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + StatRoot::INIT_SPACE,
        seeds = [b"stat-root", match_id.as_ref()],
        bump,
    )]
    pub stat_root: Account<'info, StatRoot>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ValidateStat<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"stat-root", stat_root.match_id.as_ref()],
        bump  = stat_root.bump,
    )]
    pub stat_root: Account<'info, StatRoot>,

    /// Ephemeral scratch account written by TxLINE and consumed by the CPI
    /// caller (TabulaMarkets). Init-if-needed so keeper bots can retry.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + StatReceipt::INIT_SPACE,
        seeds = [b"receipt", stat_root.key().as_ref(), stat_root.match_id.as_ref()],
        bump,
    )]
    pub receipt: Account<'info, StatReceipt>,

    pub system_program: Program<'info, System>,
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct TxLineConfig {
    pub authority: Pubkey,
    pub bump:      u8,
}

#[account]
#[derive(InitSpace)]
pub struct StatRoot {
    pub match_id:     [u8; 32],
    pub merkle_root:  [u8; 32],
    pub authority:    Pubkey,
    pub published_at: i64,
    pub bump:         u8,
}

#[account]
#[derive(InitSpace)]
pub struct StatReceipt {
    pub match_id:    [u8; 32],
    pub stat_type:   [u8; 16],
    pub stat_value:  u64,
    pub verified:    bool,
    pub verified_at: i64,
}

// --------------------------------------------------------------------------
// Events / Errors
// --------------------------------------------------------------------------

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
}

#[event]
pub struct StatRootPublished {
    pub match_id:    [u8; 32],
    pub merkle_root: [u8; 32],
    pub authority:   Pubkey,
}

#[event]
pub struct StatValidated {
    pub match_id:   [u8; 32],
    pub stat_type:  [u8; 16],
    pub stat_value: u64,
}

#[error_code]
pub enum TxLineError {
    #[msg("Merkle proof does not reconstruct to the anchored root")]
    InvalidProof,
    #[msg("Only the configured TxLINE authority may publish roots")]
    Unauthorized,
}
