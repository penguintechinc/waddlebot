import { useState, useEffect } from 'react';
import { superAdminApi } from '../../services/api';
import { Settings, Save, RefreshCw, Check, X, Eye, EyeOff, AlertCircle } from 'lucide-react';

// Platform icons as simple SVG components
const DiscordIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
  </svg>
);

const TwitchIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor">
    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
  </svg>
);

const SlackIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor">
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
  </svg>
);

const YouTubeIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor">
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

const PLATFORM_CONFIG = {
  discord: {
    name: 'Discord',
    icon: DiscordIcon,
    color: 'bg-indigo-500',
    fields: [
      { key: 'bot_token', label: 'Bot Token', secret: true, placeholder: 'Bot token from Discord Developer Portal' },
      { key: 'client_id', label: 'Client ID', secret: false, placeholder: 'OAuth2 Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true, placeholder: 'OAuth2 Client Secret' },
      { key: 'webhook_secret', label: 'Webhook Secret', secret: true, placeholder: 'Webhook verification secret' },
    ],
  },
  twitch: {
    name: 'Twitch',
    icon: TwitchIcon,
    color: 'bg-purple-500',
    fields: [
      { key: 'client_id', label: 'Client ID', secret: false, placeholder: 'Twitch Developer Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true, placeholder: 'Twitch Developer Client Secret' },
      { key: 'webhook_secret', label: 'Webhook Secret', secret: true, placeholder: 'EventSub webhook secret' },
    ],
  },
  slack: {
    name: 'Slack',
    icon: SlackIcon,
    color: 'bg-green-500',
    fields: [
      { key: 'bot_token', label: 'Bot Token', secret: true, placeholder: 'xoxb-... Bot User OAuth Token' },
      { key: 'client_id', label: 'Client ID', secret: false, placeholder: 'Slack App Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true, placeholder: 'Slack App Client Secret' },
      { key: 'signing_secret', label: 'Signing Secret', secret: true, placeholder: 'Request Signing Secret' },
    ],
  },
  youtube: {
    name: 'YouTube',
    icon: YouTubeIcon,
    color: 'bg-red-500',
    fields: [
      { key: 'api_key', label: 'API Key', secret: true, placeholder: 'YouTube Data API v3 key' },
      { key: 'client_id', label: 'Client ID', secret: false, placeholder: 'Google Cloud OAuth Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true, placeholder: 'Google Cloud OAuth Client Secret' },
    ],
  },
};

export default function SuperAdminPlatformConfig() {
  const [configs, setConfigs] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [testing, setTesting] = useState({});
  const [testResults, setTestResults] = useState({});
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showSecrets, setShowSecrets] = useState({});
  const [formData, setFormData] = useState({});
  const [expandedPlatform, setExpandedPlatform] = useState(null);

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      setLoading(true);
      const response = await superAdminApi.getPlatformConfigs();
      setConfigs(response.data.configs);

      // Initialize form data with existing values
      const initialFormData = {};
      for (const [platform, config] of Object.entries(response.data.configs)) {
        initialFormData[platform] = {};
        for (const [key, field] of Object.entries(config.fields || {})) {
          initialFormData[platform][key] = field.value || '';
        }
      }
      setFormData(initialFormData);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load platform configurations');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (platform, key, value) => {
    setFormData(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform],
        [key]: value,
      },
    }));
  };

  const handleSave = async (platform) => {
    try {
      setSaving(prev => ({ ...prev, [platform]: true }));
      setError(null);

      // Only send non-empty values
      const data = {};
      for (const [key, value] of Object.entries(formData[platform] || {})) {
        if (value && value.trim()) {
          data[key] = value.trim();
        }
      }

      await superAdminApi.updatePlatformConfig(platform, data);
      setSuccess(`${PLATFORM_CONFIG[platform].name} configuration saved successfully`);
      loadConfigs();

      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.message || `Failed to save ${platform} configuration`);
    } finally {
      setSaving(prev => ({ ...prev, [platform]: false }));
    }
  };

  const handleTest = async (platform) => {
    try {
      setTesting(prev => ({ ...prev, [platform]: true }));
      setTestResults(prev => ({ ...prev, [platform]: null }));

      const response = await superAdminApi.testPlatformConnection(platform);
      setTestResults(prev => ({
        ...prev,
        [platform]: {
          success: response.data.success,
          message: response.data.message,
        },
      }));
    } catch (err) {
      setTestResults(prev => ({
        ...prev,
        [platform]: {
          success: false,
          message: err.response?.data?.message || 'Connection test failed',
        },
      }));
    } finally {
      setTesting(prev => ({ ...prev, [platform]: false }));
    }
  };

  const toggleShowSecret = (platform, key) => {
    const fieldKey = `${platform}-${key}`;
    setShowSecrets(prev => ({ ...prev, [fieldKey]: !prev[fieldKey] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Platform Configuration
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Configure API credentials for Discord, Twitch, Slack, and YouTube integrations
          </p>
        </div>
        <button
          onClick={loadConfigs}
          className="flex items-center gap-2 px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500" />
          <span className="text-red-700 dark:text-red-400">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4 text-red-500" />
          </button>
        </div>
      )}

      {success && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 flex items-center gap-3">
          <Check className="w-5 h-5 text-green-500" />
          <span className="text-green-700 dark:text-green-400">{success}</span>
        </div>
      )}

      {/* Platform Cards */}
      <div className="grid gap-6">
        {Object.entries(PLATFORM_CONFIG).map(([platform, config]) => {
          const Icon = config.icon;
          const platformConfig = configs[platform] || { fields: {} };
          const isExpanded = expandedPlatform === platform;
          const testResult = testResults[platform];

          return (
            <div
              key={platform}
              className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden"
            >
              {/* Platform Header */}
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                onClick={() => setExpandedPlatform(isExpanded ? null : platform)}
              >
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-lg ${config.color} text-white`}>
                    <Icon />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                      {config.name}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {platformConfig.configured ? (
                        <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                          <Check className="w-4 h-4" /> Configured
                        </span>
                      ) : (
                        <span className="text-yellow-600 dark:text-yellow-400">Not configured</span>
                      )}
                    </p>
                  </div>
                </div>
                <Settings className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </div>

              {/* Expanded Configuration */}
              {isExpanded && (
                <div className="border-t border-gray-200 dark:border-gray-700 p-6 space-y-4">
                  {config.fields.map((field) => {
                    const fieldKey = `${platform}-${field.key}`;
                    const fieldConfig = platformConfig.fields?.[field.key] || {};
                    const showSecret = showSecrets[fieldKey];

                    return (
                      <div key={field.key}>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {field.label}
                          {field.secret && (
                            <span className="ml-2 text-xs text-gray-500">(encrypted)</span>
                          )}
                        </label>
                        <div className="relative">
                          <input
                            type={field.secret && !showSecret ? 'password' : 'text'}
                            value={formData[platform]?.[field.key] || ''}
                            onChange={(e) => handleInputChange(platform, field.key, e.target.value)}
                            placeholder={fieldConfig.hasValue ? fieldConfig.masked : field.placeholder}
                            className="w-full px-4 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                          />
                          {field.secret && (
                            <button
                              type="button"
                              onClick={() => toggleShowSecret(platform, field.key)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            >
                              {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          )}
                        </div>
                        {fieldConfig.source === 'environment' && (
                          <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                            Value from environment variable
                          </p>
                        )}
                      </div>
                    );
                  })}

                  {/* Test Result */}
                  {testResult && (
                    <div className={`p-3 rounded-lg ${testResult.success ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'}`}>
                      <div className="flex items-center gap-2">
                        {testResult.success ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                        {testResult.message}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-3 pt-4">
                    <button
                      onClick={() => handleSave(platform)}
                      disabled={saving[platform]}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saving[platform] ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Configuration
                    </button>
                    <button
                      onClick={() => handleTest(platform)}
                      disabled={testing[platform]}
                      className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                    >
                      {testing[platform] ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      Test Connection
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Info Note */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <h4 className="font-medium text-blue-900 dark:text-blue-300 mb-2">Security Note</h4>
        <p className="text-sm text-blue-700 dark:text-blue-400">
          Secrets are encrypted at rest. Environment variables take precedence over stored values.
          For production deployments, consider using environment variables for sensitive credentials.
        </p>
      </div>
    </div>
  );
}
