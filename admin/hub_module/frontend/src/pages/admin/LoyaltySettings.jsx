import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi } from '../../services/api';

function LoyaltySettings() {
  const { communityId } = useParams();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetchConfig();
  }, [communityId]);

  async function fetchConfig() {
    setLoading(true);
    try {
      const response = await adminApi.getLoyaltyConfig(communityId);
      if (response.data.success) {
        setConfig(response.data.config);
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
      setMessage({ type: 'error', text: 'Failed to load loyalty configuration' });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      await adminApi.updateLoyaltyConfig(communityId, config);
      setMessage({ type: 'success', text: 'Loyalty configuration saved successfully' });
    } catch (err) {
      console.error('Failed to save config:', err);
      const errorMsg = err.response?.data?.error?.message || 'Failed to save configuration';
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setSaving(false);
    }
  }

  function updateConfig(key, value) {
    setConfig({ ...config, [key]: value });
  }

  function updateNumber(key, value) {
    const numValue = parseFloat(value) || 0;
    setConfig({ ...config, [key]: numValue });
  }

  function updateInteger(key, value) {
    const numValue = parseInt(value) || 0;
    setConfig({ ...config, [key]: numValue });
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center py-12 text-red-400">
        Failed to load configuration
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-sky-100">Loyalty Settings</h1>
          <p className="text-navy-400 mt-1">
            Configure currency, earning rates, gambling, and gear systems
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg border ${
          message.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            : 'bg-red-500/20 text-red-300 border-red-500/30'
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">x</button>
        </div>
      )}

      <div className="space-y-6">
        {/* Currency Settings */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Currency Settings</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-navy-300 mb-2">
                Currency Name
              </label>
              <input
                type="text"
                value={config.currency_name || 'Points'}
                onChange={(e) => updateConfig('currency_name', e.target.value)}
                placeholder="Points"
                className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                  text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
              <p className="text-xs text-navy-500 mt-1">E.g., "Points", "Coins", "Waddles"</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-navy-300 mb-2">
                Currency Symbol
              </label>
              <input
                type="text"
                value={config.currency_symbol || '$'}
                onChange={(e) => updateConfig('currency_symbol', e.target.value)}
                placeholder="$"
                maxLength={3}
                className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                  text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
              <p className="text-xs text-navy-500 mt-1">E.g., "$", "W", "C"</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-navy-300 mb-2">
                Currency Emoji
              </label>
              <input
                type="text"
                value={config.currency_emoji || '🪙'}
                onChange={(e) => updateConfig('currency_emoji', e.target.value)}
                placeholder="🪙"
                maxLength={2}
                className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                  text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
              <p className="text-xs text-navy-500 mt-1">E.g., "🪙", "🐧", "💎"</p>
            </div>
          </div>
        </div>

        {/* Chat Earning Settings */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Chat Earning Settings</h2>
          <div className="space-y-4">
            <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
              <div className="flex items-center gap-3">
                <span className="text-2xl">💬</span>
                <div>
                  <div className="font-medium text-sky-100">Chat Messages</div>
                  <div className="text-sm text-navy-400">
                    Earn currency for sending chat messages
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.chat_enabled || false}
                onChange={(e) => updateConfig('chat_enabled', e.target.checked)}
                className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
              />
            </label>

            {config.chat_enabled && (
              <div className="ml-11 grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Chat Rate (per message)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={config.chat_rate ?? 0.5}
                    onChange={(e) => updateNumber('chat_rate', e.target.value)}
                    className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                      text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                  <p className="text-xs text-navy-500 mt-1">Default: 0.5</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Chat Cooldown (seconds)
                  </label>
                  <input
                    type="number"
                    value={config.chat_cooldown ?? 30}
                    onChange={(e) => updateInteger('chat_cooldown', e.target.value)}
                    className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                      text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                  <p className="text-xs text-navy-500 mt-1">Default: 30 seconds</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Engagement Earning Rates */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-2">Engagement Earning Rates</h2>
          <p className="text-sm text-navy-400 mb-4">
            Configure earning rates for different platform engagement actions
          </p>
          <div className="space-y-4">
            {/* Follow */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">👤</span>
                  <div>
                    <div className="font-medium text-sky-100">Follow</div>
                    <div className="text-sm text-navy-400">Earn currency for following</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.follow_enabled || false}
                  onChange={(e) => updateConfig('follow_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.follow_enabled && (
                <input
                  type="number"
                  step="1"
                  value={config.follow_rate ?? 100}
                  onChange={(e) => updateNumber('follow_rate', e.target.value)}
                  className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                    text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              )}
            </div>

            {/* Subscription */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⭐</span>
                  <div>
                    <div className="font-medium text-sky-100">Subscription</div>
                    <div className="text-sm text-navy-400">Earn currency for subscribing</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.subscription_enabled || false}
                  onChange={(e) => updateConfig('subscription_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.subscription_enabled && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-navy-400 mb-1">Tier 1 Rate</label>
                    <input
                      type="number"
                      step="1"
                      value={config.subscription_rate ?? 500}
                      onChange={(e) => updateNumber('subscription_rate', e.target.value)}
                      className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                        text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-navy-400 mb-1">Tier 2 Multiplier</label>
                      <input
                        type="number"
                        step="0.1"
                        value={config.subscription_t2_multiplier ?? 2.0}
                        onChange={(e) => updateNumber('subscription_t2_multiplier', e.target.value)}
                        className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                          text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-navy-400 mb-1">Tier 3 Multiplier</label>
                      <input
                        type="number"
                        step="0.1"
                        value={config.subscription_t3_multiplier ?? 3.0}
                        onChange={(e) => updateNumber('subscription_t3_multiplier', e.target.value)}
                        className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                          text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Gift Subscription */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🎁</span>
                  <div>
                    <div className="font-medium text-sky-100">Gift Subscription</div>
                    <div className="text-sm text-navy-400">Earn currency for gifting subs</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.gift_subscription_enabled || false}
                  onChange={(e) => updateConfig('gift_subscription_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.gift_subscription_enabled && (
                <input
                  type="number"
                  step="1"
                  value={config.gift_rate ?? 300}
                  onChange={(e) => updateNumber('gift_rate', e.target.value)}
                  className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                    text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              )}
            </div>

            {/* Raid */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🚀</span>
                  <div>
                    <div className="font-medium text-sky-100">Raid</div>
                    <div className="text-sm text-navy-400">Earn currency for raiding</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.raid_enabled || false}
                  onChange={(e) => updateConfig('raid_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.raid_enabled && (
                <input
                  type="number"
                  step="1"
                  value={config.raid_rate ?? 200}
                  onChange={(e) => updateNumber('raid_rate', e.target.value)}
                  className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                    text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              )}
            </div>

            {/* Cheer */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">💎</span>
                  <div>
                    <div className="font-medium text-sky-100">Cheer (Bits)</div>
                    <div className="text-sm text-navy-400">Earn currency per 100 bits</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.cheer_enabled || false}
                  onChange={(e) => updateConfig('cheer_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.cheer_enabled && (
                <input
                  type="number"
                  step="1"
                  value={config.cheer_per_100bits ?? 100}
                  onChange={(e) => updateNumber('cheer_per_100bits', e.target.value)}
                  className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                    text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              )}
            </div>

            {/* Donation */}
            <div className="p-4 bg-navy-800 rounded-lg">
              <label className="flex items-center justify-between mb-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">💵</span>
                  <div>
                    <div className="font-medium text-sky-100">Donation</div>
                    <div className="text-sm text-navy-400">Earn currency per dollar donated</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.donation_enabled || false}
                  onChange={(e) => updateConfig('donation_enabled', e.target.checked)}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
              {config.donation_enabled && (
                <input
                  type="number"
                  step="1"
                  value={config.donation_per_dollar ?? 100}
                  onChange={(e) => updateNumber('donation_per_dollar', e.target.value)}
                  className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                    text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              )}
            </div>
          </div>
        </div>

        {/* Gambling Settings */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Gambling Settings</h2>
          <div className="space-y-4">
            <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🎰</span>
                <div>
                  <div className="font-medium text-sky-100">Gambling System</div>
                  <div className="text-sm text-navy-400">
                    Enable gambling features (slots, coinflip, roulette)
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.gambling_enabled || false}
                onChange={(e) => updateConfig('gambling_enabled', e.target.checked)}
                className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
              />
            </label>

            {config.gambling_enabled && (
              <div className="ml-11 space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-navy-300 mb-2">
                      Minimum Bet
                    </label>
                    <input
                      type="number"
                      value={config.min_bet ?? 10}
                      onChange={(e) => updateInteger('min_bet', e.target.value)}
                      className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                        text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                    <p className="text-xs text-navy-500 mt-1">Default: 10</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-navy-300 mb-2">
                      Maximum Bet
                    </label>
                    <input
                      type="number"
                      value={config.max_bet ?? 10000}
                      onChange={(e) => updateInteger('max_bet', e.target.value)}
                      className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                        text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                    <p className="text-xs text-navy-500 mt-1">Default: 10000</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center justify-between p-3 bg-navy-700 rounded-lg cursor-pointer">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🎰</span>
                      <span className="text-sm text-sky-100">Slots</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={config.slots_enabled || false}
                      onChange={(e) => updateConfig('slots_enabled', e.target.checked)}
                      className="w-4 h-4 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                    />
                  </label>

                  <label className="flex items-center justify-between p-3 bg-navy-700 rounded-lg cursor-pointer">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🪙</span>
                      <span className="text-sm text-sky-100">Coinflip</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={config.coinflip_enabled || false}
                      onChange={(e) => updateConfig('coinflip_enabled', e.target.checked)}
                      className="w-4 h-4 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                    />
                  </label>

                  <label className="flex items-center justify-between p-3 bg-navy-700 rounded-lg cursor-pointer">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🎡</span>
                      <span className="text-sm text-sky-100">Roulette</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={config.roulette_enabled || false}
                      onChange={(e) => updateConfig('roulette_enabled', e.target.checked)}
                      className="w-4 h-4 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Duel Settings */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Duel Settings</h2>
          <div className="space-y-4">
            <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
              <div className="flex items-center gap-3">
                <span className="text-2xl">⚔️</span>
                <div>
                  <div className="font-medium text-sky-100">Duels</div>
                  <div className="text-sm text-navy-400">
                    Enable user-to-user currency duels
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.duels_enabled || false}
                onChange={(e) => updateConfig('duels_enabled', e.target.checked)}
                className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
              />
            </label>

            {config.duels_enabled && (
              <div className="ml-11 grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Minimum Wager
                  </label>
                  <input
                    type="number"
                    value={config.min_wager ?? 10}
                    onChange={(e) => updateInteger('min_wager', e.target.value)}
                    className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                      text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                  <p className="text-xs text-navy-500 mt-1">Default: 10</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Maximum Wager
                  </label>
                  <input
                    type="number"
                    value={config.max_wager ?? 5000}
                    onChange={(e) => updateInteger('max_wager', e.target.value)}
                    className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                      text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                  <p className="text-xs text-navy-500 mt-1">Default: 5000</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Duel Timeout (minutes)
                  </label>
                  <input
                    type="number"
                    value={config.duel_timeout ?? 5}
                    onChange={(e) => updateInteger('duel_timeout', e.target.value)}
                    className="w-full px-3 py-2 bg-navy-700 border border-navy-600 rounded-lg
                      text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                  <p className="text-xs text-navy-500 mt-1">Default: 5 minutes</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Gear Settings */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Gear Settings</h2>
          <div className="space-y-4">
            <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
              <div className="flex items-center gap-3">
                <span className="text-2xl">⚙️</span>
                <div>
                  <div className="font-medium text-sky-100">Gear System</div>
                  <div className="text-sm text-navy-400">
                    Enable gear collection and management
                  </div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.gear_enabled || false}
                onChange={(e) => updateConfig('gear_enabled', e.target.checked)}
                className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
              />
            </label>

            {config.gear_enabled && (
              <div className="ml-11">
                <label className="flex items-center justify-between p-3 bg-navy-700 rounded-lg cursor-pointer">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">📦</span>
                    <div>
                      <div className="text-sm text-sky-100">Gear Drops</div>
                      <div className="text-xs text-navy-400">
                        Allow random gear drops for active users
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config.gear_drops_enabled || false}
                    onChange={(e) => updateConfig('gear_drops_enabled', e.target.checked)}
                    className="w-4 h-4 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoyaltySettings;
