// Kestrel — trustless conditional-order execution engine for Solana perps.
//
// KEEPER-BRIDGE model (devnet ER watches/triggers, off-chain keeper fills on FlashTrade mainnet):
//   create_order (+ Fill receipt)  ->  delegate to ER  ->  check (crank) ->
//   on trigger: commit + Magic Action `mark_triggered` stamps Fill = Triggered (the fire signal) ->
//   [off-chain keeper opens the position on FlashTrade mainnet with the session key + builder code] ->
//   keeper calls `confirm_fill` -> Fill = Settled, with the mainnet tx signature anchored on-chain.
//
// The chain therefore proves the trigger fired BEFORE the fill, and anchors the fill's mainnet
// signature back — that's the trustless-ish + receipts (#8) story.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

declare_id!("JXiSmxyKzXaiCQ28WawpQ3RBmCPuw3Gvvfzg4VTKyML");

pub const ORDER_SEED: &[u8] = b"order";
pub const FILL_SEED: &[u8] = b"fill";

#[ephemeral]
#[program]
pub mod kestrel {
    use super::*;

    pub fn create_order(ctx: Context<CreateOrder>, id: u64, params: OrderParams) -> Result<()> {
        let order = &mut ctx.accounts.order;
        order.id = id;
        order.owner = ctx.accounts.owner.key();
        order.session_authority = params.session_authority;
        order.market = params.market;
        order.kind = params.kind;
        order.side = params.side;
        order.trigger_price = params.trigger_price;
        order.trail_offset = params.trail_offset;
        order.high_water = params.reference_price;
        order.size = params.size;
        order.status = OrderStatus::Armed as u8;

        let fill = &mut ctx.accounts.fill;
        fill.order = order.key();
        fill.session_authority = params.session_authority; // who may confirm the mainnet fill
        fill.keeper = Pubkey::default();
        fill.fired_price = 0;
        fill.entry_price = 0;
        fill.slot = 0;
        fill.status = OrderStatus::Armed as u8;
        fill.sig = [0u8; 64];
        msg!("Kestrel: order armed for {}", order.owner);
        Ok(())
    }

    pub fn delegate_order(ctx: Context<DelegateOrder>, id: u64) -> Result<()> {
        if ctx.accounts.order.owner != &ephemeral_rollups_sdk::id() {
            let validator = ctx.accounts.validator.as_ref();
            let id_bytes = id.to_le_bytes();
            ctx.accounts.delegate_order(
                &ctx.accounts.owner,
                &[ORDER_SEED, ctx.accounts.owner.key().as_ref(), &id_bytes],
                DelegateConfig {
                    validator: validator.map(|v| v.key()),
                    ..Default::default()
                },
            )?;
        } else {
            msg!("Order already delegated");
        }
        Ok(())
    }

    /// CRANK — runs on the ER. Keeper passes the price (step 1; on-chain oracle read is step 2).
    pub fn check(ctx: Context<Check>, price: u64) -> Result<()> {
        let order = &mut ctx.accounts.order;
        if order.status != OrderStatus::Armed as u8 {
            return Ok(());
        }
        if order.kind == OrderKind::TrailingStop as u8 && price > order.high_water {
            order.high_water = price;
        }
        if !is_triggered(order, price) {
            msg!("Kestrel: price {} — not triggered", price);
            return Ok(());
        }
        order.status = OrderStatus::Triggered as u8;
        order.exit(&crate::ID)?;

        // Post-commit Magic Action: stamp the Fill receipt = Triggered (the keeper's fire signal).
        let ix_data = anchor_lang::InstructionData::data(&crate::instruction::MarkTriggered { price });
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta { pubkey: ctx.accounts.fill.key().to_bytes().into(), is_writable: true },
                ShortAccountMeta { pubkey: ctx.accounts.order.key().to_bytes().into(), is_writable: false },
            ],
            args: ActionArgs::new(ix_data),
            escrow_authority: ctx.accounts.payer.to_account_info(),
            compute_units: 200_000,
        };

        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.order.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        msg!("Kestrel: triggered at {} — keeper to fill on FlashTrade mainnet", price);
        Ok(())
    }

    /// Magic Action target (base layer): stamp Fill = Triggered with the fired price.
    pub fn mark_triggered(ctx: Context<MarkTriggered>, price: u64) -> Result<()> {
        let fill = &mut ctx.accounts.fill;
        fill.status = OrderStatus::Triggered as u8;
        fill.fired_price = price;
        fill.slot = Clock::get()?.slot;
        msg!("Kestrel: fire signal — triggered at {}", price);
        Ok(())
    }

    /// Called by the keeper AFTER it opens the position on FlashTrade mainnet.
    /// Stamps Fill = Settled and anchors the mainnet tx signature + entry price on-chain.
    pub fn confirm_fill(ctx: Context<ConfirmFill>, entry_price: u64, sig: [u8; 64]) -> Result<()> {
        let fill = &mut ctx.accounts.fill;
        require!(fill.status == OrderStatus::Triggered as u8, KestrelError::NotTriggered);
        fill.status = OrderStatus::Settled as u8;
        fill.entry_price = entry_price;
        fill.sig = sig;
        fill.keeper = ctx.accounts.keeper.key();
        fill.slot = Clock::get()?.slot;
        msg!("Kestrel: fill confirmed on FlashTrade mainnet at entry {}", entry_price);
        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.order.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

fn is_triggered(order: &Order, price: u64) -> bool {
    match OrderKind::try_from(order.kind) {
        Ok(OrderKind::StopLoss) => price <= order.trigger_price,
        Ok(OrderKind::TakeProfit) => price >= order.trigger_price,
        Ok(OrderKind::TrailingStop) => price <= order.high_water.saturating_sub(order.trail_offset),
        Ok(OrderKind::LimitBuy) => price <= order.trigger_price,
        _ => false,
    }
}

#[error_code]
pub enum KestrelError {
    #[msg("Fill is not in the Triggered state")]
    NotTriggered,
}

#[account]
pub struct Order {
    pub id: u64,
    pub owner: Pubkey,
    pub session_authority: Pubkey,
    pub market: Pubkey,
    pub kind: u8,
    pub side: u8,
    pub trigger_price: u64,
    pub trail_offset: u64,
    pub high_water: u64,
    pub size: u64,
    pub status: u8,
}

#[account]
pub struct Fill {
    pub order: Pubkey,
    pub session_authority: Pubkey,
    pub keeper: Pubkey,
    pub fired_price: u64,
    pub entry_price: u64,
    pub slot: u64,
    pub status: u8,
    pub sig: [u8; 64], // FlashTrade mainnet tx signature (raw bytes)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderParams {
    pub session_authority: Pubkey,
    pub market: Pubkey,
    pub kind: u8,
    pub side: u8,
    pub trigger_price: u64,
    pub trail_offset: u64,
    pub reference_price: u64,
    pub size: u64,
}

#[repr(u8)]
pub enum OrderStatus {
    Armed = 0,
    Triggered = 1,
    Settled = 2,
    Cancelled = 3,
}

#[repr(u8)]
pub enum OrderKind {
    StopLoss = 0,
    TakeProfit = 1,
    TrailingStop = 2,
    LimitBuy = 3,
}

impl TryFrom<u8> for OrderKind {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, ()> {
        match v {
            0 => Ok(OrderKind::StopLoss),
            1 => Ok(OrderKind::TakeProfit),
            2 => Ok(OrderKind::TrailingStop),
            3 => Ok(OrderKind::LimitBuy),
            _ => Err(()),
        }
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateOrder<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + core::mem::size_of::<Order>(),
        seeds = [ORDER_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + core::mem::size_of::<Fill>(),
        seeds = [FILL_SEED, order.key().as_ref()],
        bump
    )]
    pub fill: Account<'info, Fill>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct DelegateOrder<'info> {
    pub owner: Signer<'info>,
    /// CHECK: the order PDA to delegate
    #[account(mut, del, seeds = [ORDER_SEED, owner.key().as_ref(), &id.to_le_bytes()], bump)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: checked by the delegate program
    pub validator: Option<UncheckedAccount<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct Check<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ORDER_SEED, order.owner.as_ref(), &order.id.to_le_bytes()], bump)]
    pub order: Account<'info, Order>,
    /// CHECK: Fill receipt PDA (base layer) — written by the action
    #[account(seeds = [FILL_SEED, order.key().as_ref()], bump)]
    pub fill: UncheckedAccount<'info>,
    /// CHECK: our program id, required so the post-commit action can CPI back in
    pub program_id: UncheckedAccount<'info>,
}

#[action]
#[derive(Accounts)]
pub struct MarkTriggered<'info> {
    #[account(mut, seeds = [FILL_SEED, order.key().as_ref()], bump)]
    pub fill: Account<'info, Fill>,
    /// CHECK: the order (delegated) — read only
    pub order: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ConfirmFill<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
        seeds = [FILL_SEED, fill.order.as_ref()],
        bump,
        constraint = fill.session_authority == keeper.key() @ KestrelError::NotTriggered
    )]
    pub fill: Account<'info, Fill>,
}

#[commit]
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ORDER_SEED, order.owner.as_ref()], bump)]
    pub order: Account<'info, Order>,
}