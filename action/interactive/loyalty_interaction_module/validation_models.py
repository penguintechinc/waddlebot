"""
Loyalty Interaction Module - Pydantic Validation Models

Input validation models for currency transactions, gear purchases, minigames,
and other loyalty system operations with real economic impact requiring strict
validation.
"""

from pydantic import BaseModel, Field, validator
from typing import Optional
from flask_core.validation import (
    BaseModel,
    Field,
    validator,
)


# ============================================================================
# Currency Transaction Models
# ============================================================================

class CurrencyTransactionRequest(BaseModel):
    """
    Validation model for currency transactions (add, remove, adjust).

    Enforces economic safety with strict amount limits and transaction type validation.
    """
    community_id: int = Field(..., gt=0, description="Community ID (must be positive)")
    user_id: str = Field(..., min_length=1, max_length=255, description="Platform user ID")
    username: str = Field(..., min_length=1, max_length=255, description="Username")
    amount: int = Field(
        ...,
        ge=-1000000,
        le=1000000,
        description="Transaction amount (-1M to +1M, cannot be 0)"
    )
    reason: str = Field(..., min_length=1, max_length=500, description="Transaction reason")
    transaction_type: str = Field(
        ...,
        regex=r'^(earn|spend|admin_adjust)$',
        description="Transaction type: earn, spend, or admin_adjust"
    )
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('amount')
    def validate_amount_not_zero(cls, v):
        """Ensure amount is never zero (would be no-op transaction)."""
        if v == 0:
            raise ValueError('amount cannot be zero')
        return v

    @validator('user_id', 'username')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'  # Reject unknown fields


class CurrencyTransferRequest(BaseModel):
    """
    Validation model for currency transfers between users.

    Critical economic operation requiring validation of both parties.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    from_user_id: str = Field(..., min_length=1, max_length=255, description="Source user ID")
    to_user_id: str = Field(..., min_length=1, max_length=255, description="Destination user ID")
    amount: int = Field(..., gt=0, le=1000000, description="Transfer amount (1 to 1M)")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('to_user_id')
    def validate_different_users(cls, v, values):
        """Ensure users aren't transferring to themselves."""
        if 'from_user_id' in values and v == values['from_user_id']:
            raise ValueError('cannot transfer currency to yourself')
        return v

    @validator('from_user_id', 'to_user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class SetBalanceRequest(BaseModel):
    """
    Validation model for setting exact balance (admin operation).

    Dangerous operation requiring careful validation.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    balance: int = Field(..., ge=0, le=10000000, description="New balance (0 to 10M)")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


# ============================================================================
# Gear System Models
# ============================================================================

class GearPurchaseRequest(BaseModel):
    """
    Validation model for gear purchases.

    Controls virtual goods transactions with quantity limits.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    username: str = Field(..., min_length=1, max_length=255, description="Username")
    gear_id: int = Field(..., gt=0, description="Gear item ID")
    quantity: int = Field(default=1, ge=1, le=100, description="Purchase quantity (1-100)")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id', 'username')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class GearCreateRequest(BaseModel):
    """
    Validation model for creating gear items (admin operation).

    Controls gear shop inventory with pricing and rarity validation.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    name: str = Field(..., min_length=3, max_length=100, description="Gear name (3-100 chars)")
    description: Optional[str] = Field(None, max_length=500, description="Gear description")
    price: int = Field(..., ge=1, le=1000000, description="Price in currency (1 to 1M)")
    icon_url: Optional[str] = Field(None, description="Icon URL (must be valid and safe)")
    category: Optional[str] = Field(None, max_length=50, description="Item category")
    rarity: str = Field(
        default='common',
        regex=r'^(common|uncommon|rare|epic|legendary)$',
        description="Item rarity tier"
    )
    is_tradeable: bool = Field(default=True, description="Can item be traded between users")
    max_quantity: Optional[int] = Field(None, ge=1, le=10000, description="Max purchasable quantity")

    @validator('icon_url')
    def validate_icon_url(cls, v):
        """Validate icon URL is safe and properly formatted."""
        if v is not None and v.strip():
            from flask_core.sanitization import sanitized_url_validator
            return sanitized_url_validator(v.strip(), allowed_schemes=['http', 'https'])
        return v

    @validator('name', 'category')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if v and not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip() if v else v

    class Config:
        extra = 'forbid'


class GearActionRequest(BaseModel):
    """
    Validation model for gear actions (buy, equip, unequip).

    Simple ID-based operations on gear inventory.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    item_id: int = Field(..., gt=0, description="Gear item ID")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


# ============================================================================
# Minigame Models
# ============================================================================

class MinigameWagerRequest(BaseModel):
    """
    Validation model for minigame wagers.

    Critical validation for gambling operations with configurable limits.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    username: str = Field(..., min_length=1, max_length=255, description="Username")
    game_type: str = Field(
        ...,
        regex=r'^(coinflip|dice|slots|rps|roulette)$',
        description="Game type: coinflip, dice, slots, rps, or roulette"
    )
    wager_amount: int = Field(..., ge=1, le=10000, description="Wager amount (1-10000)")
    choice: Optional[str] = Field(None, max_length=50, description="Player choice for certain games")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id', 'username')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class CoinflipRequest(BaseModel):
    """
    Validation model specifically for coinflip game.

    Validates choice and bet amount.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    bet: int = Field(..., ge=1, le=10000, description="Bet amount")
    choice: str = Field(
        ...,
        regex=r'^(heads|tails)$',
        description="Coin side choice: heads or tails"
    )
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class SlotsRequest(BaseModel):
    """
    Validation model for slots game.

    Simple bet validation for slot machine.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    bet: int = Field(..., ge=1, le=10000, description="Bet amount")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class RouletteRequest(BaseModel):
    """
    Validation model for roulette game.

    Validates bet type and optional bet value.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    bet: int = Field(..., ge=1, le=10000, description="Bet amount")
    bet_type: str = Field(
        ...,
        regex=r'^(number|red|black|odd|even|high|low)$',
        description="Bet type: number, red, black, odd, even, high, or low"
    )
    bet_value: Optional[int] = Field(
        None,
        ge=0,
        le=36,
        description="Specific number for number bet (0-36)"
    )
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('bet_value')
    def validate_bet_value_required_for_number(cls, v, values):
        """Ensure bet_value is provided when bet_type is 'number'."""
        if 'bet_type' in values and values['bet_type'] == 'number':
            if v is None:
                raise ValueError('bet_value is required when bet_type is "number"')
        return v

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


# ============================================================================
# Duel System Models
# ============================================================================

class DuelChallengeRequest(BaseModel):
    """
    Validation model for creating duel challenges.

    PvP currency wagering requires validation of both participants.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    challenger_id: str = Field(..., min_length=1, max_length=255, description="Challenger user ID")
    opponent_id: str = Field(..., min_length=1, max_length=255, description="Opponent user ID")
    wager: int = Field(..., ge=1, le=10000, description="Wager amount (1-10000)")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('opponent_id')
    def validate_different_users(cls, v, values):
        """Ensure users aren't dueling themselves."""
        if 'challenger_id' in values and v == values['challenger_id']:
            raise ValueError('cannot duel yourself')
        return v

    @validator('challenger_id', 'opponent_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class DuelActionRequest(BaseModel):
    """
    Validation model for duel actions (accept, decline).

    Simple ID-based operations on pending duels.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    duel_id: int = Field(..., gt=0, description="Duel ID")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    class Config:
        extra = 'forbid'


# ============================================================================
# Giveaway System Models
# ============================================================================

class GiveawayCreateRequest(BaseModel):
    """
    Validation model for creating giveaways.

    Controls giveaway parameters with reputation weighting options.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    title: str = Field(..., min_length=3, max_length=200, description="Giveaway title")
    prize: str = Field(..., min_length=1, max_length=500, description="Prize description")
    entry_cost: int = Field(default=0, ge=0, le=100000, description="Entry cost in currency")
    duration_minutes: int = Field(
        default=60,
        ge=1,
        le=10080,
        description="Duration in minutes (max 1 week)"
    )
    max_entries: Optional[int] = Field(None, ge=1, le=100000, description="Maximum entries allowed")
    reputation_weighted: bool = Field(
        default=False,
        description="Use reputation-based weighting for winner selection"
    )

    @validator('title', 'prize')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


class GiveawayEntryRequest(BaseModel):
    """
    Validation model for entering giveaways.

    Simple validation for giveaway participation.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    giveaway_id: int = Field(..., gt=0, description="Giveaway ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


# ============================================================================
# Leaderboard and Query Models
# ============================================================================

class LeaderboardParams(BaseModel):
    """
    Validation model for leaderboard queries.

    Supports multiple metrics with pagination.
    """
    community_id: Optional[int] = Field(None, gt=0, description="Community ID filter")
    metric: str = Field(
        default='balance',
        regex=r'^(balance|total_earned|total_spent|gear_count|duel_wins|game_wins)$',
        description="Metric to rank by"
    )
    limit: int = Field(default=10, ge=1, le=100, description="Number of results (1-100)")
    offset: int = Field(default=0, ge=0, description="Result offset for pagination")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    class Config:
        extra = 'forbid'


class EarningConfigUpdate(BaseModel):
    """
    Validation model for updating earning configuration.

    Controls currency earning rates for various activities.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    earn_chat: Optional[int] = Field(None, ge=0, le=1000, description="Currency per chat message")
    earn_chat_cooldown: Optional[int] = Field(
        None,
        ge=0,
        le=3600,
        description="Cooldown between chat earnings (seconds)"
    )
    earn_watch_time: Optional[int] = Field(
        None,
        ge=0,
        le=1000,
        description="Currency per watch interval"
    )
    earn_watch_interval: Optional[int] = Field(
        None,
        ge=60,
        le=3600,
        description="Watch time earning interval (seconds)"
    )
    earn_follow: Optional[int] = Field(None, ge=0, le=10000, description="Currency for follow")
    earn_sub_t1: Optional[int] = Field(None, ge=0, le=100000, description="Currency for T1 sub")
    earn_sub_t2: Optional[int] = Field(None, ge=0, le=100000, description="Currency for T2 sub")
    earn_sub_t3: Optional[int] = Field(None, ge=0, le=100000, description="Currency for T3 sub")
    earn_sub_gift: Optional[int] = Field(None, ge=0, le=100000, description="Currency for gifted sub")
    earn_raid_per_viewer: Optional[int] = Field(
        None,
        ge=0,
        le=100,
        description="Currency per viewer in raid"
    )
    earn_cheer_per_bit: Optional[int] = Field(
        None,
        ge=0,
        le=100,
        description="Currency per bit cheered"
    )

    class Config:
        extra = 'forbid'


class EventEarningRequest(BaseModel):
    """
    Validation model for processing event-based earnings.

    Handles follow, sub, raid, and other platform events.
    """
    community_id: int = Field(..., gt=0, description="Community ID")
    user_id: str = Field(..., min_length=1, max_length=255, description="User ID")
    event_type: str = Field(
        ...,
        regex=r'^(follow|sub_t1|sub_t2|sub_t3|sub_gift|raid|cheer|host)$',
        description="Event type"
    )
    event_data: dict = Field(default_factory=dict, description="Additional event data")
    platform: str = Field(
        default='twitch',
        regex=r'^(twitch|discord|slack|kick)$',
        description="Platform name"
    )

    @validator('user_id')
    def validate_no_whitespace_only(cls, v):
        """Ensure strings are not just whitespace."""
        if not v.strip():
            raise ValueError('field cannot be empty or whitespace only')
        return v.strip()

    class Config:
        extra = 'forbid'


__all__ = [
    # Currency models
    'CurrencyTransactionRequest',
    'CurrencyTransferRequest',
    'SetBalanceRequest',
    # Gear models
    'GearPurchaseRequest',
    'GearCreateRequest',
    'GearActionRequest',
    # Minigame models
    'MinigameWagerRequest',
    'CoinflipRequest',
    'SlotsRequest',
    'RouletteRequest',
    # Duel models
    'DuelChallengeRequest',
    'DuelActionRequest',
    # Giveaway models
    'GiveawayCreateRequest',
    'GiveawayEntryRequest',
    # Query models
    'LeaderboardParams',
    'EarningConfigUpdate',
    'EventEarningRequest',
]
