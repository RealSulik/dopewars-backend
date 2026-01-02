import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DRUG_NAMES = ['Weed', 'Acid', 'Cocaine', 'Heroin'];
const PRICE_RANGES = {
  0: { min: 100, max: 1000 },
  1: { min: 1000, max: 4000 },
  2: { min: 15000, max: 30000 },
  3: { min: 5000, max: 15000 }
};

const CITY_MULTIPLIERS = [
  [1.0, 1.2, 1.5, 1.1],
  [0.9, 1.1, 0.8, 0.7],
  [1.1, 1.0, 1.0, 1.0],
  [0.95, 0.9, 1.05, 1.0],
  [1.3, 1.4, 1.6, 1.2],
  [1.0, 1.0, 0.9, 1.6],
  [1.4, 1.2, 1.7, 1.3]
];

// Constants
const DEBT_INTEREST_RATE = 10; // 10% per day
const BANK_INTEREST_RATE = 2; // 2% per day
const COAT_UPGRADE_COST = 5000;
const GUN_COST = 3000;
const COP_REWARD = 2000;
const COP_DAMAGE = 25;
const MAX_DAYS = 30; // ENFORCE 30 DAY LIMIT

function generatePrice(drugIndex: number, location: number): number {
  const range = PRICE_RANGES[drugIndex as keyof typeof PRICE_RANGES];
  const mid = (range.min + range.max) / 2;
  const halfRange = (range.max - range.min) / 2;
  const offset = Math.random() * (halfRange * 2) - halfRange;
  let price = mid + offset;
  price = price * CITY_MULTIPLIERS[location][drugIndex];
  price = Math.max(range.min, Math.min(range.max, price));
  return Math.round(price);
}

function generateRandomEvent(day: number, hasGun: boolean): { description: string; cashChange: number } {
  const roll = Math.random();
  
  if (day < 10) {
    // Early days: mostly positive events
    if (roll > 0.8) {
      const gain = Math.floor(Math.random() * 1000);
      return { description: `Found $${gain.toLocaleString()} in cash!`, cashChange: gain };
    }
  } else if (day > 20) {
    // Late game: higher stakes, but REDUCED robbery frequency
    if (roll > 0.85) {
      const gain = Math.floor(Math.random() * 1500);
      return { description: `Big score! Found $${gain.toLocaleString()}!`, cashChange: gain };
    } else if (roll > 0.7) { // CHANGED FROM 0.5 TO 0.7 = 30% chance instead of 50%
      const loss = Math.floor(Math.random() * 3000);
      return { description: `Robbed! Lost $${loss.toLocaleString()}`, cashChange: -loss };
    }
  } else {
    // Mid game
    if (roll > 0.8) {
      const gain = Math.floor(Math.random() * 1000);
      return { description: `Found $${gain.toLocaleString()} stash!`, cashChange: gain };
    } else if (roll > 0.7) { // CHANGED FROM 0.5 TO 0.7 = 30% chance
      const loss = Math.floor(Math.random() * 1000);
      return { description: `Crooked cops took $${loss.toLocaleString()}`, cashChange: -loss };
    }
  }
  
  return { description: 'Uneventful day.', cashChange: 0 };
}

function checkForCopEncounter(day: number): boolean {
  // 15% chance of cop encounter, increasing with days
  const baseChance = 0.15;
  const dayMultiplier = Math.min(day / 30, 1); // Max 100% increase
  const chance = baseChance * (1 + dayMultiplier);
  return Math.random() < chance;
}

// NEW: Check for RANDOM coat upgrade offer (original Dope Wars mechanic!)
function checkForCoatUpgradeOffer(day: number, coatUpgrades: number): boolean {
  // Can only get ONE upgrade total (original game)
  if (coatUpgrades >= 1) return false;
  
  // 10% chance during days 5-25
  if (day >= 5 && day <= 25) {
    return Math.random() < 0.10;
  }
  
  return false;
}

async function getCurrentPrices(runId: string, day: number, location: number) {
  const { data } = await supabase
    .from('daily_prices')
    .select('*')
    .eq('run_id', runId)
    .eq('day', day)
    .eq('location', location)
    .single();

  if (data) {
    return {
      weed: data.weed_price,
      acid: data.acid_price,
      cocaine: data.cocaine_price,
      heroin: data.heroin_price
    };
  }

  // Generate new prices if they don't exist
  const prices = {
    weed: generatePrice(0, location),
    acid: generatePrice(1, location),
    cocaine: generatePrice(2, location),
    heroin: generatePrice(3, location)
  };

  // Add small delay before inserting to avoid race conditions
  await new Promise(resolve => setTimeout(resolve, 100));

  await supabase.from('daily_prices').insert({
    run_id: runId,
    day,
    location,
    weed_price: prices.weed,
    acid_price: prices.acid,
    cocaine_price: prices.cocaine,
    heroin_price: prices.heroin
  });

  return prices;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { playerAddress, action } = body;

    if (!playerAddress) {
      return NextResponse.json(
        { success: false, error: 'Player address required' },
        { status: 400 }
      );
    }

    // Get active game run
    const { data: gameRun, error: runError } = await supabase
      .from('game_runs')
      .select('*')
      .eq('wallet_address', playerAddress)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (runError || !gameRun) {
      return NextResponse.json(
        { success: false, error: 'No active game found' },
        { status: 404 }
      );
    }

    // ===== ENFORCE DAY 30 LIMIT =====
    if (gameRun.days_played >= MAX_DAYS && action !== 'settle') {
      return NextResponse.json(
        { 
          success: false, 
          error: `Game ended! You've reached day ${MAX_DAYS}. Time to settle!`,
          mustSettle: true 
        },
        { status: 400 }
      );
    }

    let updateData: any = {};
    let eventDescription = '';

    switch (action) {
      // ===== BUY DRUG =====
      case 'buy': {
        const { drugIndex, amount } = body;

        if (drugIndex < 0 || drugIndex > 3 || !amount || amount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Invalid drug or amount' },
            { status: 400 }
          );
        }

        const prices = await getCurrentPrices(gameRun.id, gameRun.days_played, gameRun.location);
        const priceArray = [prices.weed, prices.acid, prices.cocaine, prices.heroin];
        const totalCost = priceArray[drugIndex] * amount;

        if (gameRun.cash < totalCost) {
          return NextResponse.json(
            { success: false, error: `Not enough cash. Need $${totalCost.toLocaleString()}` },
            { status: 400 }
          );
        }

        const currentInventory = gameRun.weed + gameRun.acid + gameRun.cocaine + gameRun.heroin;
        if (currentInventory + amount > gameRun.trenchcoat_capacity) {
          return NextResponse.json(
            { success: false, error: `Not enough space! Capacity: ${gameRun.trenchcoat_capacity}` },
            { status: 400 }
          );
        }

        const drugColumn = ['weed', 'acid', 'cocaine', 'heroin'][drugIndex];
        updateData = {
          cash: gameRun.cash - totalCost,
          [drugColumn]: gameRun[drugColumn] + amount
        };
        eventDescription = `Bought ${amount} ${DRUG_NAMES[drugIndex]} for $${totalCost.toLocaleString()}.`;
        break;
      }

      // ===== SELL DRUG =====
      case 'sell': {
        const { drugIndex, amount } = body;

        if (drugIndex < 0 || drugIndex > 3 || !amount || amount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Invalid drug or amount' },
            { status: 400 }
          );
        }

        const drugColumn = ['weed', 'acid', 'cocaine', 'heroin'][drugIndex];
        if (gameRun[drugColumn] < amount) {
          return NextResponse.json(
            { success: false, error: `Not enough ${DRUG_NAMES[drugIndex]}` },
            { status: 400 }
          );
        }

        const prices = await getCurrentPrices(gameRun.id, gameRun.days_played, gameRun.location);
        const priceArray = [prices.weed, prices.acid, prices.cocaine, prices.heroin];
        const totalEarned = priceArray[drugIndex] * amount;

        updateData = {
          cash: gameRun.cash + totalEarned,
          [drugColumn]: gameRun[drugColumn] - amount
        };
        eventDescription = `Sold ${amount} ${DRUG_NAMES[drugIndex]} for $${totalEarned.toLocaleString()}.`;
        break;
      }

      // ===== TRAVEL (ENDS DAY + RANDOM EVENTS) =====
      case 'travelTo': {
        const { location } = body;
        
        if (location < 0 || location > 6) {
          return NextResponse.json(
            { success: false, error: 'Invalid location' },
            { status: 400 }
          );
        }

        if (location === gameRun.location) {
          return NextResponse.json(
            { success: false, error: 'Already at this location' },
            { status: 400 }
          );
        }

        if (gameRun.health <= 0) {
          return NextResponse.json(
            { success: false, error: 'Cannot travel - you are dead!' },
            { status: 400 }
          );
        }

        const newDay = gameRun.days_played + 1;
        
        // Calculate interest
        const newDebt = Math.floor(gameRun.debt * (1 + DEBT_INTEREST_RATE / 100));
        const newBank = Math.floor(gameRun.bank_balance * (1 + BANK_INTEREST_RATE / 100));

        updateData = {
          location,
          days_played: newDay,
          debt: newDebt,
          bank_balance: newBank
        };

        eventDescription = `Day ${newDay}/${MAX_DAYS}`;
        
        // Check for RANDOM events during travel
        let travelEvents: string[] = [];
        
        // 1. Check for cop encounter
        const copEncounter = checkForCopEncounter(newDay);
        if (copEncounter) {
          updateData.cop_encounter_pending = true; // FLAG FOR FRONTEND
          travelEvents.push('⚠️ OFFICER HARDASS SPOTTED YOU!');
        }
        
        // 2. Check for coat upgrade offer (ORIGINAL MECHANIC!)
        const coatOffer = checkForCoatUpgradeOffer(newDay, gameRun.coat_upgrades);
        if (coatOffer) {
          updateData.coat_offer_pending = true; // FLAG FOR FRONTEND
          travelEvents.push(`🧥 Someone offers to sell you a bigger trenchcoat for $${COAT_UPGRADE_COST.toLocaleString()}!`);
        }
        
        if (travelEvents.length > 0) {
          eventDescription += ' | ' + travelEvents.join(' | ');
        }
        
        break;
      }

      // ===== END DAY (NO TRAVEL) =====
      case 'endDay': {
        if (gameRun.health <= 0) {
          return NextResponse.json(
            { success: false, error: 'Cannot end day - you are dead!' },
            { status: 400 }
          );
        }

        const newDay = gameRun.days_played + 1;
        
        // Calculate interest
        const newDebt = Math.floor(gameRun.debt * (1 + DEBT_INTEREST_RATE / 100));
        const newBank = Math.floor(gameRun.bank_balance * (1 + BANK_INTEREST_RATE / 100));

        // Generate event
        const event = generateRandomEvent(newDay, gameRun.has_gun);
        const newCash = Math.max(0, gameRun.cash + event.cashChange);

        updateData = {
          days_played: newDay,
          cash: newCash,
          debt: newDebt,
          bank_balance: newBank
        };

        eventDescription = `Day ${newDay}/${MAX_DAYS}. ${event.description}`;

        // Record event
        await supabase.from('game_events').insert({
          run_id: gameRun.id,
          day: newDay,
          event_type: 'daily_event',
          description: event.description,
          cash_change: event.cashChange
        });

        break;
      }

      // ===== HUSTLE =====
      case 'hustle': {
        if (gameRun.hustles_used >= 3) {
          return NextResponse.json(
            { success: false, error: 'Max hustles used (3 per game)' },
            { status: 400 }
          );
        }

        const hustleAmount = Math.floor(Math.random() * 2000) + 500;
        updateData = {
          cash: gameRun.cash + hustleAmount,
          hustles_used: gameRun.hustles_used + 1
        };
        eventDescription = `Hustled and earned $${hustleAmount.toLocaleString()}! (${gameRun.hustles_used + 1}/3 used)`;
        break;
      }

      // ===== STASH =====
      case 'stash': {
        if (gameRun.stashes_used >= 3) {
          return NextResponse.json(
            { success: false, error: 'Max stashes used (3 per game)' },
            { status: 400 }
          );
        }

        const drugToGive = Math.floor(Math.random() * 4);
        const amountToGive = Math.floor(Math.random() * 15) + 5;
        
        // Check capacity
        const currentInventory = gameRun.weed + gameRun.acid + gameRun.cocaine + gameRun.heroin;
        if (currentInventory + amountToGive > gameRun.trenchcoat_capacity) {
          return NextResponse.json(
            { success: false, error: 'Not enough space for stash!' },
            { status: 400 }
          );
        }

        const drugColumn = ['weed', 'acid', 'cocaine', 'heroin'][drugToGive];
        updateData = {
          [drugColumn]: gameRun[drugColumn] + amountToGive,
          stashes_used: gameRun.stashes_used + 1
        };
        // FIXED: Better description showing what was found
        eventDescription = `Found a stash with ${amountToGive} ${DRUG_NAMES[drugToGive]}! (${gameRun.stashes_used + 1}/3 used)`;
        break;
      }

      // ===== DEPOSIT TO BANK =====
      case 'depositBank': {
        const { amount } = body;
        
        if (!amount || amount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Invalid amount' },
            { status: 400 }
          );
        }

        if (gameRun.cash < amount) {
          return NextResponse.json(
            { success: false, error: 'Not enough cash' },
            { status: 400 }
          );
        }

        updateData = {
          cash: gameRun.cash - amount,
          bank_balance: gameRun.bank_balance + amount
        };
        eventDescription = `Deposited $${amount.toLocaleString()} to bank. Balance: $${(gameRun.bank_balance + amount).toLocaleString()}`;
        break;
      }

      // ===== WITHDRAW FROM BANK =====
      case 'withdrawBank': {
        const { amount } = body;
        
        if (!amount || amount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Invalid amount' },
            { status: 400 }
          );
        }

        if (gameRun.bank_balance < amount) {
          return NextResponse.json(
            { success: false, error: 'Not enough in bank' },
            { status: 400 }
          );
        }

        updateData = {
          cash: gameRun.cash + amount,
          bank_balance: gameRun.bank_balance - amount
        };
        eventDescription = `Withdrew $${amount.toLocaleString()} from bank. Balance: $${(gameRun.bank_balance - amount).toLocaleString()}`;
        break;
      }

      // ===== PAY LOAN =====
      case 'payLoan': {
        const { amount } = body;
        
        if (!amount || amount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Invalid amount' },
            { status: 400 }
          );
        }

        if (gameRun.cash < amount) {
          return NextResponse.json(
            { success: false, error: 'Not enough cash' },
            { status: 400 }
          );
        }

        const actualPayment = Math.min(amount, gameRun.debt);
        updateData = {
          cash: gameRun.cash - actualPayment,
          debt: gameRun.debt - actualPayment
        };
        eventDescription = `Paid $${actualPayment.toLocaleString()} to loan shark. Debt: $${(gameRun.debt - actualPayment).toLocaleString()}`;
        break;
      }

      // ===== ACCEPT COAT OFFER (NEW!) =====
      case 'acceptCoatOffer': {
        if (!gameRun.coat_offer_pending) {
          return NextResponse.json(
            { success: false, error: 'No coat offer available' },
            { status: 400 }
          );
        }

        if (gameRun.cash < COAT_UPGRADE_COST) {
          return NextResponse.json(
            { success: false, error: `Need $${COAT_UPGRADE_COST.toLocaleString()} for upgrade` },
            { status: 400 }
          );
        }

        const newCapacity = gameRun.trenchcoat_capacity + 50;
        updateData = {
          cash: gameRun.cash - COAT_UPGRADE_COST,
          trenchcoat_capacity: newCapacity,
          coat_upgrades: gameRun.coat_upgrades + 1,
          coat_offer_pending: false
        };
        eventDescription = `🎉 Upgraded trenchcoat! Capacity: ${newCapacity} spaces.`;

        // Record upgrade
        await supabase.from('upgrades').insert({
          run_id: gameRun.id,
          day: gameRun.days_played,
          upgrade_type: 'coat',
          cost: COAT_UPGRADE_COST
        });
        break;
      }

      // ===== DECLINE COAT OFFER (NEW!) =====
      case 'declineCoatOffer': {
        updateData = {
          coat_offer_pending: false
        };
        eventDescription = 'Declined the coat upgrade offer.';
        break;
      }

      // ===== BUY GUN (Removed - guns are now random offers in original game) =====
      // Keeping for backward compatibility but should be converted to random offer
      case 'buyGun': {
        if (gameRun.has_gun) {
          return NextResponse.json(
            { success: false, error: 'Already have a gun' },
            { status: 400 }
          );
        }

        if (gameRun.cash < GUN_COST) {
          return NextResponse.json(
            { success: false, error: `Need $${GUN_COST.toLocaleString()} for gun` },
            { status: 400 }
          );
        }

        updateData = {
          cash: gameRun.cash - GUN_COST,
          has_gun: true
        };
        eventDescription = 'Bought a gun! Now you can fight back against cops.';

        // Record upgrade
        await supabase.from('upgrades').insert({
          run_id: gameRun.id,
          day: gameRun.days_played,
          upgrade_type: 'gun',
          cost: GUN_COST
        });
        break;
      }

      // ===== FIGHT COP =====
      case 'fightCop': {
        if (!gameRun.cop_encounter_pending) {
          return NextResponse.json(
            { success: false, error: 'No cop encounter active' },
            { status: 400 }
          );
        }

        // Better odds with gun
        const fightChance = gameRun.has_gun ? 0.6 : 0.3;
        const wonFight = Math.random() < fightChance;

        updateData = {
          cop_encounter_pending: false
        };

        if (wonFight) {
          updateData.cash = gameRun.cash + COP_REWARD;
          eventDescription = `💪 Fought Officer Hardass and won! +$${COP_REWARD.toLocaleString()}`;

          await supabase.from('combat_events').insert({
            run_id: gameRun.id,
            day: gameRun.days_played,
            event_type: 'fight_won',
            cash_change: COP_REWARD,
            health_change: 0,
            description: eventDescription
          });
        } else {
          const newHealth = Math.max(0, gameRun.health - COP_DAMAGE);
          updateData.health = newHealth;
          eventDescription = `😵 Fought Officer Hardass but got hurt! -${COP_DAMAGE} health`;

          if (newHealth <= 0) {
            eventDescription += ' 💀 You died!';
            updateData.status = 'lost';
          }

          await supabase.from('combat_events').insert({
            run_id: gameRun.id,
            day: gameRun.days_played,
            event_type: 'fight_lost',
            cash_change: 0,
            health_change: -COP_DAMAGE,
            description: eventDescription
          });
        }
        break;
      }

      // ===== RUN FROM COP =====
      case 'runFromCop': {
        if (!gameRun.cop_encounter_pending) {
          return NextResponse.json(
            { success: false, error: 'No cop encounter active' },
            { status: 400 }
          );
        }

        // 70% chance to escape
        const escaped = Math.random() < 0.7;

        updateData = {
          cop_encounter_pending: false
        };

        if (escaped) {
          eventDescription = '🏃 Ran away from Officer Hardass! Got away safely.';
          await supabase.from('combat_events').insert({
            run_id: gameRun.id,
            day: gameRun.days_played,
            event_type: 'ran_away',
            cash_change: 0,
            health_change: 0,
            description: eventDescription
          });
        } else {
          const damage = Math.floor(COP_DAMAGE / 2); // Less damage than fighting
          const newHealth = Math.max(0, gameRun.health - damage);
          updateData.health = newHealth;
          eventDescription = `😰 Tried to run but got shot! -${damage} health`;

          if (newHealth <= 0) {
            eventDescription += ' 💀 You died!';
            updateData.status = 'lost';
          }

          await supabase.from('combat_events').insert({
            run_id: gameRun.id,
            day: gameRun.days_played,
            event_type: 'run_failed',
            cash_change: 0,
            health_change: -damage,
            description: eventDescription
          });
        }
        break;
      }

      // ===== CLAIM DAILY ICE =====
      case 'claimDailyIce': {
        const { data: player } = await supabase
          .from('players')
          .select('total_ice, last_ice_claim_at')
          .eq('wallet_address', playerAddress)
          .single();

        if (!player) {
          return NextResponse.json(
            { success: false, error: 'Player not found' },
            { status: 404 }
          );
        }

        const now = new Date();
        const lastClaim = player.last_ice_claim_at ? new Date(player.last_ice_claim_at) : null;

        if (lastClaim) {
          const timeSince = now.getTime() - lastClaim.getTime();
          const hoursSince = timeSince / (1000 * 60 * 60);

          if (hoursSince < 24) {
            const hoursLeft = Math.ceil(24 - hoursSince);
            return NextResponse.json(
              { success: false, error: `Claim available in ${hoursLeft} hours` },
              { status: 400 }
            );
          }
        }

        const iceReward = Math.floor(Math.random() * 3) + 1;
        const newTotalIce = (player.total_ice || 0) + iceReward;

        await supabase
          .from('players')
          .update({
            total_ice: newTotalIce,
            last_ice_claim_at: now.toISOString()
          })
          .eq('wallet_address', playerAddress);

        eventDescription = `Claimed ${iceReward} ICE! Total: ${newTotalIce}`;
        break;
      }

      default:
        return NextResponse.json(
          { success: false, error: 'Unknown action' },
          { status: 400 }
        );
    }

    // Update game state
    updateData.last_event_description = eventDescription;
    updateData.last_event = eventDescription;

    // ===== CHECK WIN CONDITION (Track when player first hits $1M) =====
    if (!gameRun.won_at_day) {
      // Calculate current net worth
      const currentPrices = await getCurrentPrices(gameRun.id, gameRun.days_played, gameRun.location);
      const priceArray = [currentPrices.weed, currentPrices.acid, currentPrices.cocaine, currentPrices.heroin];
      
      const drugValue = 
        (gameRun.weed * priceArray[0]) +
        (gameRun.acid * priceArray[1]) +
        (gameRun.cocaine * priceArray[2]) +
        (gameRun.heroin * priceArray[3]);
      
      const currentNetWorth = Math.max(0,
        (updateData.cash !== undefined ? updateData.cash : gameRun.cash) +
        (updateData.bank_balance !== undefined ? updateData.bank_balance : gameRun.bank_balance) -
        (updateData.debt !== undefined ? updateData.debt : gameRun.debt) +
        drugValue
      );
      
      // If hit $1M for first time, record it!
      if (currentNetWorth >= 1_000_000) {
        updateData.won_at_day = gameRun.days_played;
        console.log(`🎉 Player won at day ${gameRun.days_played}! Net worth: $${currentNetWorth.toLocaleString()}`);
      }
    }

    const { error: updateError } = await supabase
      .from('game_runs')
      .update(updateData)
      .eq('id', gameRun.id);

    if (updateError) throw updateError;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Action error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Action failed' },
      { status: 500 }
    );
  }
}