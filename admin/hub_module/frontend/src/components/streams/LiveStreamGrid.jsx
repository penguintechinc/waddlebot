import { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import LiveStreamCard from './LiveStreamCard';

/**
 * LiveStreamGrid Component
 * Displays a grid of live stream cards with refresh functionality
 */
function LiveStreamGrid({ streams, onRefresh, loading = false, error = null }) {
  const [expandedStream, setExpandedStream] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Auto-refresh every 60 seconds if enabled
  useEffect(() => {
    if (!autoRefresh || !onRefresh) return;

    const interval = setInterval(() => {
      onRefresh();
    }, 60000); // 60 seconds

    return () => clearInterval(interval);
  }, [autoRefresh, onRefresh]);

  const handleExpand = (entityId, isExpanded) => {
    setExpandedStream(isExpanded ? entityId : null);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gold-400"></div>
          <p className="text-navy-400">Loading live streams...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <div className="text-red-400 mb-4">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h3 className="text-sky-100 font-semibold mb-2">Error Loading Streams</h3>
        <p className="text-navy-400 mb-4">{error}</p>
        {onRefresh && (
          <button onClick={onRefresh} className="btn btn-primary">
            Try Again
          </button>
        )}
      </div>
    );
  }

  if (!streams || streams.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-6xl mb-4">📺</div>
        <h3 className="text-xl font-semibold text-sky-100 mb-2">No Live Streams</h3>
        <p className="text-navy-400 mb-4">No one from your community is currently streaming.</p>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
          >
            Refresh
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <h2 className="text-xl font-bold text-sky-100 flex items-center space-x-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
            </span>
            <span>Live Now</span>
          </h2>
          <span className="bg-navy-800 text-sky-300 text-sm font-semibold px-3 py-1 rounded-full">
            {streams.length} {streams.length === 1 ? 'stream' : 'streams'}
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-sm px-3 py-1 rounded-lg transition-colors ${
              autoRefresh
                ? 'bg-purple-600 bg-opacity-20 text-purple-400 border border-purple-500'
                : 'bg-navy-800 text-navy-400 border border-navy-700'
            }`}
          >
            {autoRefresh ? '🔄 Auto' : '⏸️ Manual'}
          </button>

          {/* Manual refresh button */}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="text-sm px-3 py-1 bg-navy-800 hover:bg-navy-700 text-sky-300 rounded-lg transition-colors flex items-center space-x-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span>Refresh</span>
            </button>
          )}
        </div>
      </div>

      {/* Stream grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {streams.map((stream) => (
          <LiveStreamCard key={stream.entityId} stream={stream} onExpand={handleExpand} />
        ))}
      </div>

      {/* Expanded stream takes priority (shown above grid) */}
      {expandedStream && streams.find((s) => s.entityId === expandedStream) && (
        <div className="mt-4">
          <LiveStreamCard
            stream={streams.find((s) => s.entityId === expandedStream)}
            onExpand={handleExpand}
          />
        </div>
      )}
    </div>
  );
}

LiveStreamGrid.propTypes = {
  streams: PropTypes.arrayOf(
    PropTypes.shape({
      entityId: PropTypes.string.isRequired,
      channelName: PropTypes.string.isRequired,
      viewerCount: PropTypes.number,
      title: PropTypes.string,
      game: PropTypes.string,
      thumbnailUrl: PropTypes.string,
    })
  ),
  onRefresh: PropTypes.func,
  loading: PropTypes.bool,
  error: PropTypes.string,
};

export default LiveStreamGrid;
