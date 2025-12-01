import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi } from '../../services/api';
import { ClipboardDocumentIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

function AdminBrowserSources() {
  const { communityId } = useParams();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    fetchSources();
  }, [communityId]);

  async function fetchSources() {
    setLoading(true);
    try {
      const response = await adminApi.getBrowserSources(communityId);
      setSources(response.data.sources);
    } catch (err) {
      console.error('Failed to fetch sources:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate(sourceType) {
    try {
      await adminApi.regenerateBrowserSources(communityId, sourceType);
      fetchSources();
    } catch (err) {
      console.error('Failed to regenerate:', err);
    }
  }

  function copyToClipboard(url, type) {
    navigator.clipboard.writeText(url);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }

  const sourceInfo = {
    ticker: { label: 'Ticker', desc: 'Scrolling text notifications and alerts', icon: '📢' },
    media: { label: 'Media', desc: 'Music and video display with album art', icon: '🎵' },
    general: { label: 'General', desc: 'Custom HTML content and announcements', icon: '📋' },
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Browser Sources</h1>
      <p className="text-slate-600 mb-6">
        Use these URLs in OBS Studio browser sources to display community content.
      </p>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-waddle-orange"></div>
        </div>
      ) : (
        <div className="space-y-4">
          {sources.map((source) => {
            const info = sourceInfo[source.sourceType] || { label: source.sourceType, desc: '', icon: '🔗' };
            return (
              <div key={source.sourceType} className="card p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <span className="text-2xl">{info.icon}</span>
                    <div>
                      <h3 className="font-semibold">{info.label}</h3>
                      <p className="text-sm text-slate-600">{info.desc}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRegenerate(source.sourceType)}
                    className="text-slate-400 hover:text-slate-600"
                    title="Regenerate URL"
                  >
                    <ArrowPathIcon className="w-5 h-5" />
                  </button>
                </div>
                <div className="mt-4 flex items-center space-x-2">
                  <input
                    type="text"
                    readOnly
                    value={source.url}
                    className="input flex-1 bg-slate-50 text-sm font-mono"
                  />
                  <button
                    onClick={() => copyToClipboard(source.url, source.sourceType)}
                    className="btn btn-secondary"
                  >
                    <ClipboardDocumentIcon className="w-5 h-5" />
                    {copied === source.sourceType ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 card p-6 bg-blue-50 border-blue-200">
        <h3 className="font-semibold text-blue-800 mb-2">OBS Setup Tips</h3>
        <ul className="text-sm text-blue-700 space-y-1">
          <li>• Ticker: Set width to full scene width, height 50-100px, position at bottom</li>
          <li>• Media: Set size to 400x150px, position in corner for now playing display</li>
          <li>• General: Use full screen overlay for announcements</li>
        </ul>
      </div>
    </div>
  );
}

export default AdminBrowserSources;
