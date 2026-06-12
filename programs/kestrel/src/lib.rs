// Kestrel — trustless conditional-order execution engine for Solana perps.
//
// STEP 1 SPINE (this file): create_order (+ fill receipt) -> delegate to ER ->
// check (crank) -> on trigger: commit + post-commit Magic Action -> settle writes a
// base-layer Fill receipt. Mirrors magicblock-engine-examples/magic-actions (proven on devnet ER):
// the action writes a SEPARATE non-delegated account and only READS the committed order,
// which is the pattern that actually runs.
//
// QUEUED: step 3 privacy (ephemeral permission on the ER), real FlashTrade CPI in settle.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

declare_id!("JXiSmxyKzXaiCQ28WawpQ3RBmCPuw3Gvvfzg4VTKyML"); // `anchor keys sync` sets this

pub const ORDER_SEED: &[u8] = b"order";
pub const FILL_SEED: &[u8] = b"fill";

#[ephemeral]
#[program]
pub mod kestrel {
    use super::*;

    /// Arm an order on the base layer + create its Fill receipt (stays on base layer).
    pub fn create_order(ctx: Context<CreateOrder>, params: OrderParams) -> Result<()> {
        let order = &mut ctx.accounts.order;
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
        fill.status = OrderStatus::Armed as u8;
        fill.fired_price = 0;
        fill.slot = 0;
        msg!("Kestrel: order armed for {}", order.owner);
        Ok(())
    }

    /// Delegate the order PDA to the ER.
    pub fn delegate_order(ctx: Context<DelegateOrder>) -> Result<()> {
        if ctx.accounts.order.owner != &ephemeral_rollups_sdk::id() {
            let validator = ctx.accounts.validator.as_ref();
            ctx.accounts.delegate_order(
                &ctx.accounts.owner,
                &[ORDER_SEED, ctx.accounts.owner.key().as_ref()],
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

    /// CRANK — runs on the ER, called each tick by the keeper. Keeper passes the price (step 1).
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

        // Post-commit Magic Action: writes the Fill receipt on the base layer.
        let ix_data =
            anchor_lang::InstructionData::data(&crate::instruction::SettleOnFlashtrade { price });
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta {
                    pubkey: ctx.accounts.fill.key().to_bytes().into(),
                    is_writable: true,
                },
                ShortAccountMeta {
                    pubkey: ctx.accounts.order.key().to_bytes().into(),
                    is_writable: false,
                },
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
        msg!("Kestrel: triggered at {} — settling on base layer", price);
        Ok(())
    }

    /// Magic Action target — runs on the base layer after the commit. Writes the receipt.
    /// TODO(validate): add the FlashTrade openPosition/closePosition CPI here, signed by
    /// order.session_authority, with the partner builder code set.
    pub fn settle_on_flashtrade(ctx: Context<SettleOnFlashtrade>, price: u64) -> Result<()> {
        let fill = &mut ctx.accounts.fill;
        fill.status = OrderStatus::Settled as u8;
        fill.fired_price = price;
        fill.slot = Clock::get()?.slot;
        msg!("Kestrel: order settled on FlashTrade (stub) at {}", price);
        Ok(())
    }

    /// Cancel/cleanup: commit + undelegate the order.
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

#[account]
pub struct Order {
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
    pub fired_price: u64,
    pub slot: u64,
    pub status: u8,
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
pub struct CreateOrder<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + core::mem::size_of::<Order>(),
        seeds = [ORDER_SEED, owner.key().as_ref()],
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
pub struct DelegateOrder<'info> {
    pub owner: Signer<'info>,
    /// CHECK: the order PDA to delegate
    #[account(mut, del, seeds = [ORDER_SEED, owner.key().as_ref()], bump)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: checked by the delegate program
    pub validator: Option<UncheckedAccount<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct Check<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ORDER_SEED, order.owner.as_ref()], bump)]
    pub order: Account<'info, Order>,
    /// CHECK: Fill receipt PDA (base layer) — written by the action
    #[account(seeds = [FILL_SEED, order.key().as_ref()], bump)]
    pub fill: UncheckedAccount<'info>,
    /// CHECK: our program id, required so the post-commit action can CPI back in
    pub program_id: UncheckedAccount<'info>,
}

#[action]
#[derive(Accounts)]
pub struct SettleOnFlashtrade<'info> {
    #[account(mut, seeds = [FILL_SEED, order.key().as_ref()], bump)]
    pub fill: Account<'info, Fill>,
    /// CHECK: the order (delegated) — read only
    pub order: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ORDER_SEED, order.owner.as_ref()], bump)]
    pub order: Account<'info, Order>,
}