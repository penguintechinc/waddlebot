import { useState, useEffect } from 'react';
import PropTypes from 'prop-types';

/**
 * TwitchEmbed Component
 * Embeds a Twitch player iframe for live streams
 */
function TwitchEmbed({ channelName, width = '100%', height = 400, muted = true, autoplay = true }) {
  const [parent, setParent] = useState('');

  useEffect(() => {
    // Extract hostname for Twitch parent parameter
    const hostname = window.location.hostname;
    setParent(hostname || 'localhost');
  }, []);

  if (!parent) {
    return (
      <div className="flex items-center justify-center bg-navy-900 rounded-lg" style={{ width, height }}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  // Construct Twitch embed URL
  const embedUrl = new URL('https://player.twitch.tv/');
  embedUrl.searchParams.set('channel', channelName);
  embedUrl.searchParams.set('parent', parent);
  embedUrl.searchParams.set('muted', muted ? 'true' : 'false');
  embedUrl.searchParams.set('autoplay', autoplay ? 'true' : 'false');

  return (
    <div className="twitch-embed-container relative rounded-lg overflow-hidden border border-navy-700">
      <iframe
        src={embedUrl.toString()}
        width={width}
        height={height}
        allowFullScreen
        title={`${channelName} Twitch Stream`}
        className="w-full"
      />
    </div>
  );
}

TwitchEmbed.propTypes = {
  channelName: PropTypes.string.isRequired,
  width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  muted: PropTypes.bool,
  autoplay: PropTypes.bool,
};

export default TwitchEmbed;
