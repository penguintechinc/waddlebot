# Simple Games Service

Simple, luck-based games for the WaddleBot loyalty/currency system. Includes Dice, Rock-Paper-Scissors, and Magic 8-Ball.

## Overview

The Simple Games Service provides three interactive games that integrate with the loyalty currency system:

| Game | Type | Bet | Payout | Win Rate | Cooldown |
|------|------|-----|--------|----------|----------|
| **Dice** | Wagered | 10-500 | 1.5x | 66% | 15s |
| **RPS** | Wagered | 10-500 | 2x | 33% | 20s |
| **8-Ball** | Free | No | N/A | N/A | 10s |

## Features

### 1. Fair Random Number Generation
- Uses Python's `random` module for fair, non-biased outcomes
- Suitable for entertainment games with reasonable house edges

### 2. Cooldown System
- Per-user, per-game cooldowns to prevent spam
- Configurable via constants in service class
- Automatic cooldown tracking in database

### 3. Currency Integration
- Seamless integration with loyalty currency system
- Automatic bet deduction and winnings distribution
- Full transaction audit trail

### 4. Statistics & Analytics
- Win/loss tracking per user per game
- Leaderboards by wins and net earnings
- Community-wide game statistics

### 5. Configurable Per Community
- Min/max bet limits per game
- Enable/disable simple games feature
- Settings stored in `loyalty_config` table

## Games

### Dice Game

Roll a 6-sided die. Win on 4-6 (rolling higher).

**Command:** `!dice [bet]`

**Mechanics:**
- Roll 1-6 using RNG
- Win condition: Roll >= 4
- Payout: 1.5x bet on win
- House edge: 34% (reasonable for casual play)

**Example Flow:**
```
User bets 100
Roll: 5
Result: WIN 150 (1.5x)
New balance: previous_balance - 100 + 150
```

**Database Record:**
```json
{
  "game_type": "dice",
  "bet_amount": 100,
  "win_amount": 150,
  "result_data": {
    "roll": 5,
    "multiplier": 1.5,
    "winning_roll": true
  },
  "is_win": true
}
```

### Rock-Paper-Scissors (RPS) Game

Play Rock-Paper-Scissors against a bot opponent.

**Command:** `!rps [rock/paper/scissors] [bet]`

**Mechanics:**
- Player chooses: rock, paper, or scissors
- Bot randomly chooses: rock, paper, or scissors
- Win condition: Your choice beats bot's choice
- Tie condition: Same choices (bet refunded)
- Payout: 2x bet on win, refund on tie

**Win Conditions:**
- Rock beats Scissors
- Paper beats Rock
- Scissors beats Paper

**Example Flow:**
```
User plays: rock, bet 100
Bot plays: scissors
Result: WIN 200 (2x)
New balance: previous_balance - 100 + 200
```

**Database Record:**
```json
{
  "game_type": "rps",
  "bet_amount": 100,
  "win_amount": 200,
  "result_data": {
    "player_choice": "rock",
    "bot_choice": "scissors",
    "result": "win"
  },
  "is_win": true
}
```

### Magic 8-Ball Game

Ask the magic 8-ball a question for a mystical response.

**Command:** `!8ball [question]`

**Mechanics:**
- Ask any yes/no question
- Get a random response from 20 possible answers
- No betting, purely for entertainment
- Responses categorized: positive, non-committal, negative

**Available Responses:**
- **Positive (10):** It is certain, It is decidedly so, Without a doubt, Yes definitely, You may rely on it, As I see it yes, Most likely, Outlook good, Yes, Signs point to yes
- **Non-Committal (5):** Reply hazy try again, Ask again later, Better not tell you now, Cannot predict now, Concentrate and ask again
- **Negative (5):** Don't count on it, My reply is no, My sources say no, Outlook not so good, Very doubtful

**Example Flow:**
```
User asks: "Will I win the lottery?"
Response: "Very doubtful"
No currency transactions
```

**Database Record:**
```json
{
  "game_type": "eightball",
  "bet_amount": 0,
  "win_amount": 0,
  "result_data": {
    "question": "Will I win the lottery?",
    "response": "Very doubtful"
  },
  "is_win": null
}
```

## API Methods

### Play Dice

```python
async def play_dice(
    community_id: int,
    platform: str,                    # e.g., "twitch"
    platform_user_id: str,            # e.g., "123456"
    bet_amount: int,                  # Must be within min/max
    hub_user_id: int = None           # Optional for linked users
) -> GameResult
```

**Returns:** `GameResult` dataclass with:
- `success`: Whether the game was played successfully
- `is_win`: Whether player won (True/False)
- `game_type`: "dice"
- `bet_amount`: Amount wagered
- `win_amount`: Amount won
- `new_balance`: User's new currency balance
- `result_data`: Game-specific data (roll, multiplier, etc.)
- `message`: Human-readable result message
- `cooldown_seconds`: Remaining cooldown

**Example Usage:**
```python
result = await simple_games_service.play_dice(
    community_id=1,
    platform="twitch",
    platform_user_id="user123",
    bet_amount=50
)

if result.success:
    print(f"Bet: {result.bet_amount}")
    print(f"Won: {result.is_win}")
    print(f"Winnings: {result.win_amount}")
    print(f"New balance: {result.new_balance}")
    print(f"Message: {result.message}")
else:
    print(f"Error: {result.message}")
```

### Play Rock-Paper-Scissors

```python
async def play_rps(
    community_id: int,
    platform: str,
    platform_user_id: str,
    choice: str,                      # "rock", "paper", or "scissors"
    bet_amount: int,
    hub_user_id: int = None
) -> GameResult
```

**Returns:** `GameResult` dataclass with:
- `success`: Whether the game was played successfully
- `is_win`: Whether player won (True/False/None for tie)
- `game_type`: "rps"
- Other fields same as dice

**Example Usage:**
```python
result = await simple_games_service.play_rps(
    community_id=1,
    platform="twitch",
    platform_user_id="user123",
    choice="rock",
    bet_amount=50
)

if result.is_win is None:
    print(f"Tie! Bet refunded: {result.message}")
elif result.is_win:
    print(f"Victory! Won {result.win_amount}: {result.message}")
else:
    print(f"Defeat: {result.message}")
```

### Ask Magic 8-Ball

```python
async def ask_eightball(
    community_id: int,
    platform: str,
    platform_user_id: str,
    question: str,                    # Any question
    hub_user_id: int = None
) -> GameResult
```

**Returns:** `GameResult` dataclass with:
- `success`: Whether the request was successful (always True unless disabled)
- `is_win`: None (no betting)
- `game_type`: "eightball"
- `bet_amount`: 0
- `win_amount`: 0
- `new_balance`: 0 (unchanged)
- `result_data`: Contains question and response
- `message`: The magic 8-ball's response

**Example Usage:**
```python
result = await simple_games_service.ask_eightball(
    community_id=1,
    platform="twitch",
    platform_user_id="user123",
    question="Will it rain tomorrow?"
)

if result.success:
    print(result.message)  # "🎱 *shakes the 8-ball* ... Outlook good"
```

### Get Game Statistics

```python
async def get_game_stats(
    community_id: int,
    platform: str = None,            # Optional
    platform_user_id: str = None,    # Optional
    game_type: str = None            # Optional: "dice", "rps", or "eightball"
) -> Dict[str, Any]
```

**Returns:** Dictionary with statistics by game type:

```python
{
    "dice": {
        "total_games": 42,
        "wins": 28,
        "losses": 14,
        "win_rate": 66.67,
        "total_bet": 2100,
        "total_won": 2800,
        "net": 700
    },
    "rps": {
        "total_games": 30,
        "wins": 10,
        "losses": 20,
        "win_rate": 33.33,
        "total_bet": 1500,
        "total_won": 2000,
        "net": 500
    }
}
```

**Example Usage:**
```python
# Get all stats for a user
stats = await simple_games_service.get_game_stats(
    community_id=1,
    platform="twitch",
    platform_user_id="user123"
)

# Get only dice stats
dice_stats = await simple_games_service.get_game_stats(
    community_id=1,
    platform="twitch",
    platform_user_id="user123",
    game_type="dice"
)

# Get community-wide stats
community_stats = await simple_games_service.get_game_stats(
    community_id=1
)
```

### Get User Cooldowns

```python
async def get_user_cooldowns(
    community_id: int,
    platform: str,
    platform_user_id: str
) -> Dict[str, int]
```

**Returns:** Dictionary with remaining cooldown seconds by game:

```python
{
    "dice": 12,
    "rps": 18
}
```

**Example Usage:**
```python
cooldowns = await simple_games_service.get_user_cooldowns(
    community_id=1,
    platform="twitch",
    platform_user_id="user123"
)

if "dice" in cooldowns:
    print(f"Dice available in {cooldowns['dice']}s")
else:
    print("Dice is ready to play")
```

## Configuration

Configuration is stored in the `loyalty_config` table with the following columns:

```sql
-- Enable/disable all simple games
simple_games_enabled BOOLEAN DEFAULT TRUE

-- Dice game configuration
dice_min_bet INTEGER DEFAULT 10
dice_max_bet INTEGER DEFAULT 500

-- RPS game configuration
rps_min_bet INTEGER DEFAULT 10
rps_max_bet INTEGER DEFAULT 500

-- 8-Ball is always free (no bet columns)
```

### Update Configuration

```python
# Disable simple games for a community
query = """
    UPDATE loyalty_config
    SET simple_games_enabled = FALSE
    WHERE community_id = $1
"""

# Change dice bet limits
query = """
    UPDATE loyalty_config
    SET dice_min_bet = 25, dice_max_bet = 1000
    WHERE community_id = $1
"""

# Change RPS bet limits
query = """
    UPDATE loyalty_config
    SET rps_min_bet = 50, rps_max_bet = 250
    WHERE community_id = $1
"""
```

## Database Schema

### Tables

#### `loyalty_simple_game_results`
Stores all game results and statistics.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Unique result ID |
| `community_id` | INTEGER | Community context |
| `hub_user_id` | INTEGER | Hub user (optional) |
| `platform` | VARCHAR(50) | Platform name |
| `platform_user_id` | VARCHAR(255) | User identifier |
| `game_type` | VARCHAR(20) | dice, rps, or eightball |
| `bet_amount` | INTEGER | Amount wagered |
| `win_amount` | INTEGER | Amount won |
| `result_data` | JSONB | Game-specific data |
| `is_win` | BOOLEAN | Win/loss (NULL for non-wagered) |
| `created_at` | TIMESTAMPTZ | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |

**Indexes:**
- `idx_simple_games_community`: By community (chronological)
- `idx_simple_games_user`: By user (chronological)
- `idx_simple_games_type`: By game type
- `idx_simple_games_user_type`: By user and game type
- `idx_simple_games_wins`: Winning games only

#### `loyalty_simple_game_cooldowns`
Tracks per-user, per-game cooldowns.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PRIMARY KEY | Unique cooldown ID |
| `community_id` | INTEGER | Community context |
| `platform` | VARCHAR(50) | Platform name |
| `platform_user_id` | VARCHAR(255) | User identifier |
| `game_type` | VARCHAR(20) | Game type |
| `cooldown_until` | TIMESTAMPTZ | When cooldown expires |
| `created_at` | TIMESTAMPTZ | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |

**Unique Constraint:**
- `(community_id, platform, platform_user_id, game_type)`: One cooldown per user/game

**Indexes:**
- `idx_simple_cooldowns_active`: Active cooldowns
- `idx_simple_cooldowns_expired`: Expired cooldowns (for cleanup)

### Helper Functions

```sql
-- Get statistics for a user
SELECT * FROM get_simple_game_stats(community_id, platform, user_id, game_type);

-- Get leaderboard for a game
SELECT * FROM get_simple_game_leaderboard(community_id, game_type, limit);

-- Cleanup expired cooldowns
SELECT cleanup_expired_cooldowns();
```

## Cooldown System

Cooldowns prevent spam and balance gameplay. Each game has a default cooldown:

- **Dice:** 15 seconds
- **RPS:** 20 seconds
- **8-Ball:** 10 seconds

Cooldowns are:
- Per-user
- Per-game
- Per-community
- Tracked in database with expiration timestamps
- Automatically checked before each game

### Checking Cooldowns

The service automatically checks cooldowns and returns a cooldown error if active.

**In Code:**
```python
result = await simple_games_service.play_dice(...)
if not result.success and result.cooldown_seconds > 0:
    print(f"Still on cooldown for {result.cooldown_seconds}s")
```

**To Get Current Cooldowns:**
```python
cooldowns = await simple_games_service.get_user_cooldowns(
    community_id, platform, platform_user_id
)
for game, seconds in cooldowns.items():
    print(f"{game}: {seconds}s remaining")
```

## House Edge & Balance

Games are designed with reasonable house edges for casual entertainment:

### Dice (66% Win Rate)
- Expected value: 0.66 × 1.5x - 0.34 × 1x = 0.66x
- House takes: 34%
- Fair for casual play with quick rounds

### RPS (33% Win)
- Win payout: 2x (double or nothing)
- Tie rate: ~33% (automatic refund)
- Loss rate: ~33%
- Expected value: 0.33 × 2x - 0.33 × 1x + 0.33 × 0 ≈ 0.33x
- House takes: ~33%
- Player-friendly with tie mechanic

### 8-Ball (0% House Take)
- Pure entertainment with no betting
- Community engagement focused
- No house edge

## Integration with Loyalty Module

The Simple Games Service integrates seamlessly with the existing loyalty system:

### Currency Service
- Uses `CurrencyService` for balance operations
- Automatic bet deduction with `remove_currency()`
- Automatic winnings distribution with `add_currency()`
- Full transaction audit trail recorded

### Transaction Types
- `game_dice`: Dice bet
- `game_dice_win`: Dice winnings
- `game_rps`: RPS bet
- `game_rps_win`: RPS winnings
- `game_rps_tie`: RPS tie refund
- (8-Ball has no currency transactions)

### Loyalty Config
- Settings stored in `loyalty_config` table
- Per-community configuration
- Enable/disable flag for feature control

## Error Handling

All methods return a `GameResult` with `success` field:

```python
result = await simple_games_service.play_dice(...)

if not result.success:
    # Handle error
    print(f"Game failed: {result.message}")
else:
    # Process result
    print(f"Game succeeded: {result.message}")
```

### Common Errors

| Error | Cause |
|-------|-------|
| "Dice is disabled in this community" | Feature disabled |
| "Bet must be between X and Y" | Bet outside limits |
| "Insufficient balance" | Not enough currency |
| "You need to wait Xs before playing again" | Cooldown active |
| "Invalid choice. Use: rock, paper, or scissors" | Bad RPS choice |
| "Magic 8-Ball is disabled" | Feature disabled |

## Performance Considerations

### Database Indexes
- 5 indexes on results table for fast queries
- 2 indexes on cooldowns table for active cooldown checks
- Composite indexes for common query patterns

### Query Optimization
- Cooldown checks are indexed and fast (O(1) lookup)
- Statistics queries use GROUP BY for efficient aggregation
- Leaderboards use optimized ordering

### Scalability
- Per-community configuration allows independent communities
- Cooldown cleanup available as maintenance function
- Results table can be archived per rotation if needed

## Testing

### Test Currency Deduction
```python
# Start with known balance
balance_before = await currency_service.get_balance(...)

# Play a game
result = await simple_games_service.play_dice(..., bet_amount=100)

# Verify bet was deducted
assert result.new_balance == balance_before.balance - 100
```

### Test Win/Loss
```python
# Play multiple times to verify both outcomes exist
results = []
for _ in range(20):
    result = await simple_games_service.play_dice(...)
    results.append(result.is_win)

# Expect mix of wins and losses
assert True in results
assert False in results
```

### Test Cooldowns
```python
# Play a game
result1 = await simple_games_service.play_dice(...)
assert result1.success

# Immediate second play should fail
result2 = await simple_games_service.play_dice(...)
assert not result2.success
assert "wait" in result2.message.lower()
```

### Test Statistics
```python
# Get stats
stats = await simple_games_service.get_game_stats(
    community_id, platform, user_id, "dice"
)

# Verify calculations
assert stats["dice"]["wins"] + stats["dice"]["losses"] == stats["dice"]["total_games"]
assert stats["dice"]["total_won"] - stats["dice"]["total_bet"] == stats["dice"]["net"]
```

## Maintenance

### Cleanup Expired Cooldowns
Run periodically (hourly or daily) to clean up expired cooldowns:

```sql
SELECT cleanup_expired_cooldowns();
```

Or via the service (if exposed):
```python
# Can be wrapped in an endpoint for admin use
```

### Archive Results
Optionally archive old game results to improve performance:

```sql
-- Archive games older than 90 days
INSERT INTO loyalty_simple_game_results_archive
SELECT * FROM loyalty_simple_game_results
WHERE created_at < NOW() - INTERVAL '90 days'
AND id NOT IN (SELECT id FROM loyalty_simple_game_results_archive);

DELETE FROM loyalty_simple_game_results
WHERE created_at < NOW() - INTERVAL '90 days';
```

## Future Enhancements

Potential improvements for future versions:

1. **More Games:** Blackjack, higher/lower, slots (already exists)
2. **Progressive Jackpots:** Shared pool that grows with bets
3. **Tournaments:** Leaderboard competitions with prize pools
4. **Seasonal Events:** Limited-time games with special rules
5. **Achievements:** Badges for milestones (100 wins, 1000 total bets, etc.)
6. **Streaks:** Tracking win streaks and best performances
7. **Multipliers:** Daily multipliers or combo bonuses
8. **Difficulty Levels:** Higher difficulty = higher payout

## Conclusion

The Simple Games Service provides a complete, production-ready implementation of three luck-based games integrated with WaddleBot's loyalty system. Games are fair, configurable per community, and tracked with comprehensive statistics.
