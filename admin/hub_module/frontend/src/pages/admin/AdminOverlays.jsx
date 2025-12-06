import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  ClipboardDocumentIcon,
  ArrowPathIcon,
  EyeIcon,
  EyeSlashIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { adminApi } from '../../services/api';

function AdminOverlays() {
  const { communityId } = useParams();
  const [overlay, setOverlay] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadOverlay();
    loadStats();
  }, [communityId]);

  const loadOverlay = async () => {
    try {
      const response = await adminApi.getOverlay(communityId);
      setOverlay(response.data.overlay);
    } catch (err) {
      setError('Failed to load overlay');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await adminApi.getOverlayStats(communityId);
      setStats(response.data.stats);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const copyToClipboard = async () => {
    if (overlay?.overlayUrl) {
      await navigator.clipboard.writeText(overlay.overlayUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRotateKey = async () => {
    setRotating(true);
    try {
      const response = await adminApi.rotateOverlayKey(communityId);
      setOverlay(response.data.overlay);
      setShowRotateConfirm(false);
    } catch (err) {
      setError('Failed to rotate key');
    } finally {
      setRotating(false);
    }
  };

  const toggleActive = async () => {
    try {
      const response = await adminApi.updateOverlay(communityId, {
        isActive: !overlay.is_active
      });
      setOverlay(response.data.overlay);
    } catch (err) {
      setError('Failed to update overlay');
    }
  };

  const maskKey = (key) => {
    if (!key) return '';
    return key.substring(0, 8) + '••••••••••••••••••••••••••••••••••••••••••••••••' + key.substring(60);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-sky-100">Overlay Management</h1>
        <p className="text-navy-400 mt-1">
          Manage your unified browser source overlay for OBS/streaming software
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-center space-x-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-400" />
          <span className="text-red-400">{error}</span>
        </div>
      )}

      {/* Overlay URL Card */}
      <div className="bg-navy-800 border border-navy-700 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-sky-100">Overlay URL</h2>
          <button
            onClick={toggleActive}
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              overlay?.is_active
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-red-500/20 text-red-400 border border-red-500/30'
            }`}
          >
            {overlay?.is_active ? 'Active' : 'Inactive'}
          </button>
        </div>

        <div className="bg-navy-900 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between">
            <code className="text-sm text-gold-400 break-all">
              {showKey ? overlay?.overlayUrl : overlay?.overlayUrl?.replace(/\/[a-f0-9]{64}$/, '/' + maskKey(overlay?.overlay_key))}
            </code>
            <div className="flex items-center space-x-2 ml-4">
              <button
                onClick={() => setShowKey(!showKey)}
                className="p-2 text-navy-400 hover:text-sky-300 rounded"
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
              </button>
              <button
                onClick={copyToClipboard}
                className="p-2 text-navy-400 hover:text-sky-300 rounded"
                title="Copy URL"
              >
                {copied ? (
                  <CheckCircleIcon className="w-5 h-5 text-green-400" />
                ) : (
                  <ClipboardDocumentIcon className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-navy-400">
            Last accessed: {overlay?.last_accessed ? new Date(overlay.last_accessed).toLocaleString() : 'Never'}
          </p>
          <button
            onClick={() => setShowRotateConfirm(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-navy-700 hover:bg-navy-600 text-sky-100 rounded-lg transition-colors"
          >
            <ArrowPathIcon className="w-4 h-4" />
            <span>Rotate Key</span>
          </button>
        </div>
      </div>

      {/* OBS Setup Instructions */}
      <div className="bg-navy-800 border border-navy-700 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-sky-100 mb-4">OBS Setup Instructions</h2>
        <ol className="space-y-3 text-navy-300">
          <li className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gold-500/20 text-gold-400 flex items-center justify-center text-sm font-medium">1</span>
            <span>In OBS, click the + button in Sources and select "Browser"</span>
          </li>
          <li className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gold-500/20 text-gold-400 flex items-center justify-center text-sm font-medium">2</span>
            <span>Create a new source and name it "WaddleBot Overlay"</span>
          </li>
          <li className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gold-500/20 text-gold-400 flex items-center justify-center text-sm font-medium">3</span>
            <span>Paste your overlay URL into the URL field</span>
          </li>
          <li className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gold-500/20 text-gold-400 flex items-center justify-center text-sm font-medium">4</span>
            <span>Set width to 1920 and height to 1080 (or your stream resolution)</span>
          </li>
          <li className="flex items-start space-x-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gold-500/20 text-gold-400 flex items-center justify-center text-sm font-medium">5</span>
            <span>Click OK and position the source as needed</span>
          </li>
        </ol>
      </div>

      {/* Access Statistics */}
      {stats && (
        <div className="bg-navy-800 border border-navy-700 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-sky-100 mb-4">Access Statistics</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="bg-navy-900 rounded-lg p-4">
              <p className="text-sm text-navy-400">Total Access Count</p>
              <p className="text-2xl font-bold text-gold-400">{stats.total?.access_count || 0}</p>
            </div>
            <div className="bg-navy-900 rounded-lg p-4">
              <p className="text-sm text-navy-400">Last 7 Days</p>
              <p className="text-2xl font-bold text-gold-400">
                {stats.daily?.reduce((sum, d) => sum + parseInt(d.access_count), 0) || 0}
              </p>
            </div>
          </div>
          {stats.daily && stats.daily.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-navy-400 border-b border-navy-700">
                    <th className="text-left py-2">Date</th>
                    <th className="text-right py-2">Accesses</th>
                    <th className="text-right py-2">Unique IPs</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.daily.map((day) => (
                    <tr key={day.date} className="border-b border-navy-700/50">
                      <td className="py-2 text-navy-300">{new Date(day.date).toLocaleDateString()}</td>
                      <td className="py-2 text-right text-sky-100">{day.access_count}</td>
                      <td className="py-2 text-right text-sky-100">{day.unique_ips}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Rotate Confirmation Modal */}
      {showRotateConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-navy-800 border border-navy-700 rounded-lg p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold text-sky-100 mb-2">Rotate Overlay Key?</h3>
            <p className="text-navy-300 mb-4">
              This will generate a new overlay URL. The old URL will continue working for 5 minutes
              to allow you to update your OBS settings.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowRotateConfirm(false)}
                className="px-4 py-2 text-navy-300 hover:text-sky-100"
              >
                Cancel
              </button>
              <button
                onClick={handleRotateKey}
                disabled={rotating}
                className="px-4 py-2 bg-gold-500 hover:bg-gold-600 text-navy-900 font-medium rounded-lg disabled:opacity-50"
              >
                {rotating ? 'Rotating...' : 'Rotate Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminOverlays;
