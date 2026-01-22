import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  VideoCameraIcon,
  ArrowPathIcon,
  PlusIcon,
  TrashIcon,
  ClipboardIcon,
  EyeIcon,
  StopIcon,
  SignalIcon,
} from '@heroicons/react/24/outline';
import { adminApi } from '../../services/api';

function AdminLiveStreams() {
  const { communityId } = useParams();
  const [config, setConfig] = useState(null);
  const [destinations, setDestinations] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newDest, setNewDest] = useState({ platform: 'twitch', rtmp_url: '', stream_key: '', max_resolution: '1080p' });

  useEffect(() => {
    loadStreamConfig();
  }, [communityId]);

  const loadStreamConfig = async () => {
    try {
      setLoading(true);
      const [configRes, destRes, statusRes] = await Promise.all([
        adminApi.getStreamConfig(communityId).catch(() => ({ data: null })),
        adminApi.getStreamDestinations(communityId).catch(() => ({ data: { destinations: [] } })),
        adminApi.getStreamStatus(communityId).catch(() => ({ data: null })),
      ]);
      setConfig(configRes.data?.config || null);
      setDestinations(destRes.data?.destinations || []);
      setStatus(statusRes.data?.status || null);
    } catch (err) {
      setError('Failed to load stream configuration');
    } finally {
      setLoading(false);
    }
  };

  const createConfig = async () => {
    try {
      setLoading(true);
      await adminApi.createStreamConfig(communityId);
      setMessage({ type: 'success', text: 'Stream configuration created' });
      loadStreamConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create configuration');
    } finally {
      setLoading(false);
    }
  };

  const regenerateKey = async () => {
    if (!window.confirm('Regenerating will invalidate the current key. Continue?')) return;
    try {
      await adminApi.regenerateStreamKey(communityId);
      setMessage({ type: 'success', text: 'Stream key regenerated' });
      loadStreamConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to regenerate key');
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setMessage({ type: 'success', text: 'Copied to clipboard' });
  };

  const addDestination = async () => {
    try {
      await adminApi.addStreamDestination(communityId, newDest);
      setMessage({ type: 'success', text: 'Destination added' });
      setShowAddModal(false);
      setNewDest({ platform: 'twitch', rtmp_url: '', stream_key: '', max_resolution: '1080p' });
      loadStreamConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add destination');
    }
  };

  const removeDestination = async (destId) => {
    if (!window.confirm('Remove this destination?')) return;
    try {
      await adminApi.removeStreamDestination(communityId, destId);
      setMessage({ type: 'success', text: 'Destination removed' });
      loadStreamConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove destination');
    }
  };

  const toggleForceCut = async (destId) => {
    try {
      await adminApi.toggleStreamForceCut(communityId, destId);
      setMessage({ type: 'success', text: 'Force cut toggled' });
      loadStreamConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to toggle force cut');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <VideoCameraIcon className="h-8 w-8 text-sky-500" />
          Live Streaming
        </h1>
        {status?.is_streaming && (
          <span className="flex items-center gap-2 px-3 py-1 bg-red-500/20 text-red-400 rounded-full">
            <SignalIcon className="h-4 w-4 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500 text-red-300 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="float-right">&times;</button>
        </div>
      )}

      {message && (
        <div className={`px-4 py-3 rounded ${message.type === 'success' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">&times;</button>
        </div>
      )}

      {!config ? (
        <div className="card p-8 text-center">
          <VideoCameraIcon className="h-16 w-16 text-gray-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">No Stream Configuration</h2>
          <p className="text-gray-400 mb-4">Set up streaming to multicast to multiple platforms.</p>
          <button onClick={createConfig} className="btn btn-primary">
            <PlusIcon className="h-5 w-5 mr-2" />
            Create Stream Configuration
          </button>
        </div>
      ) : (
        <>
          {/* Stream Key Card */}
          <div className="card p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Stream Key</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Ingest URL</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={config.ingest_url || ''}
                    readOnly
                    className="input flex-1 bg-gray-800"
                  />
                  <button onClick={() => copyToClipboard(config.ingest_url)} className="btn btn-secondary">
                    <ClipboardIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Stream Key</label>
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={config.stream_key || ''}
                    readOnly
                    className="input flex-1 bg-gray-800"
                  />
                  <button onClick={() => setShowKey(!showKey)} className="btn btn-secondary">
                    <EyeIcon className="h-5 w-5" />
                  </button>
                  <button onClick={() => copyToClipboard(config.stream_key)} className="btn btn-secondary">
                    <ClipboardIcon className="h-5 w-5" />
                  </button>
                  <button onClick={regenerateKey} className="btn btn-warning">
                    <ArrowPathIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Destinations */}
          <div className="card p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-white">Output Destinations</h2>
              <button onClick={() => setShowAddModal(true)} className="btn btn-primary btn-sm">
                <PlusIcon className="h-4 w-4 mr-1" />
                Add Destination
              </button>
            </div>

            {destinations.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No destinations configured</p>
            ) : (
              <div className="space-y-3">
                {destinations.map((dest) => (
                  <div key={dest.id} className="flex items-center justify-between p-4 bg-gray-800 rounded-lg">
                    <div className="flex items-center gap-4">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        dest.platform === 'twitch' ? 'bg-purple-500/20 text-purple-400' :
                        dest.platform === 'youtube' ? 'bg-red-500/20 text-red-400' :
                        dest.platform === 'kick' ? 'bg-green-500/20 text-green-400' :
                        'bg-gray-500/20 text-gray-400'
                      }`}>
                        {dest.platform.toUpperCase()}
                      </span>
                      <div>
                        <p className="text-white text-sm">{dest.rtmp_url}</p>
                        <p className="text-gray-500 text-xs">Resolution: {dest.max_resolution}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleForceCut(dest.id)}
                        className={`btn btn-sm ${dest.force_cut ? 'btn-danger' : 'btn-secondary'}`}
                        title="Force Cut"
                      >
                        <StopIcon className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removeDestination(dest.id)}
                        className="btn btn-sm btn-danger"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stream Status */}
          {status && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Stream Status</h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-white">{status.is_streaming ? 'Live' : 'Offline'}</p>
                  <p className="text-gray-400 text-sm">Status</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-white">{status.viewer_count || 0}</p>
                  <p className="text-gray-400 text-sm">Viewers</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-white">{status.bitrate_kbps || 0} kbps</p>
                  <p className="text-gray-400 text-sm">Bitrate</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add Destination Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-white mb-4">Add Destination</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Platform</label>
                <select
                  value={newDest.platform}
                  onChange={(e) => setNewDest({ ...newDest, platform: e.target.value })}
                  className="input w-full"
                >
                  <option value="twitch">Twitch</option>
                  <option value="youtube">YouTube</option>
                  <option value="kick">Kick</option>
                  <option value="custom">Custom RTMP</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">RTMP URL</label>
                <input
                  type="text"
                  value={newDest.rtmp_url}
                  onChange={(e) => setNewDest({ ...newDest, rtmp_url: e.target.value })}
                  placeholder="rtmp://live.twitch.tv/app"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Stream Key</label>
                <input
                  type="password"
                  value={newDest.stream_key}
                  onChange={(e) => setNewDest({ ...newDest, stream_key: e.target.value })}
                  placeholder="Your platform stream key"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Max Resolution</label>
                <select
                  value={newDest.max_resolution}
                  onChange={(e) => setNewDest({ ...newDest, max_resolution: e.target.value })}
                  className="input w-full"
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="1440p">1440p (2K)</option>
                  <option value="2160p">2160p (4K)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowAddModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={addDestination} className="btn btn-primary">Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminLiveStreams;
