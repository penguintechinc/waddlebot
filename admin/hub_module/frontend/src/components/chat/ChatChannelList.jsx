/**
 * Chat Channel List Component
 * List of available channels with unread indicators
 */
import { HashtagIcon } from '@heroicons/react/24/outline';

export default function ChatChannelList({ channels, activeChannel, onSelectChannel }) {
  return (
    <div className="bg-gray-800 border-r border-gray-700 w-64 flex-shrink-0 overflow-y-auto">
      {/* Header */}
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-lg font-semibold text-gray-100">Channels</h2>
      </div>

      {/* Channel list */}
      <div className="p-2">
        {channels.map((channel) => (
          <button
            key={channel.name}
            onClick={() => onSelectChannel(channel.name)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left
              ${activeChannel === channel.name
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
          >
            {/* Channel icon */}
            <HashtagIcon className="w-5 h-5 flex-shrink-0" />

            {/* Channel name */}
            <span className="flex-1 font-medium truncate">{channel.name}</span>

            {/* Unread indicator (if applicable) */}
            {channel.unreadCount > 0 && activeChannel !== channel.name && (
              <span className="bg-blue-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
              </span>
            )}
          </button>
        ))}

        {channels.length === 0 && (
          <div className="text-gray-500 text-sm p-4 text-center">
            No channels available
          </div>
        )}
      </div>
    </div>
  );
}
