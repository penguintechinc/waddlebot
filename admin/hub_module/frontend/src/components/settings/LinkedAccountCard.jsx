import { useState } from 'react';
import {
  CheckCircleIcon,
  XMarkIcon,
  StarIcon
} from '@heroicons/react/24/outline';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';

const platformIcons = {
  discord: (
    <svg className="w-8 h-8" viewBox="0 0 71 55" fill="currentColor">
      <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1066 30.1693C30.1066 34.1136 27.28 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z"/>
    </svg>
  ),
  twitch: (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
    </svg>
  ),
  slack: (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  )
};

const platformColors = {
  discord: 'text-indigo-400',
  twitch: 'text-purple-400',
  slack: 'text-emerald-400'
};

function LinkedAccountCard({ platform, identity, isPrimary, onUnlink, onSetPrimary, disabled }) {
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const handleUnlink = async () => {
    try {
      setUnlinking(true);
      await onUnlink(platform);
      setShowUnlinkConfirm(false);
    } catch (error) {
      console.error('Failed to unlink account:', error);
    } finally {
      setUnlinking(false);
    }
  };

  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
  const colorClass = platformColors[platform] || 'text-sky-400';

  if (!identity) {
    return (
      <div className="card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`${colorClass} opacity-50`}>
              {platformIcons[platform]}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-sky-100">{platformName}</h3>
              <p className="text-sm text-navy-400">Not connected</p>
            </div>
          </div>
          <button
            onClick={() => onSetPrimary(platform)}
            disabled={disabled}
            className="btn btn-primary"
          >
            Link {platformName}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={colorClass}>
            {platformIcons[platform]}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-sky-100">{platformName}</h3>
              {isPrimary && (
                <span className="badge badge-gold flex items-center gap-1">
                  <StarIconSolid className="w-3 h-3" />
                  Primary
                </span>
              )}
              <CheckCircleIcon className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="flex items-center gap-2 mt-1">
              {identity.avatarUrl && (
                <img
                  src={identity.avatarUrl}
                  alt={identity.username}
                  className="w-6 h-6 rounded-full"
                />
              )}
              <p className="text-sm text-navy-300">{identity.username}</p>
            </div>
            {identity.email && (
              <p className="text-xs text-navy-400 mt-1">{identity.email}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isPrimary && (
            <button
              onClick={() => onSetPrimary(platform)}
              disabled={disabled}
              className="btn btn-secondary flex items-center gap-2"
            >
              <StarIcon className="w-4 h-4" />
              Set as Primary
            </button>
          )}

          {showUnlinkConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-navy-300">Are you sure?</span>
              <button
                onClick={handleUnlink}
                disabled={unlinking || disabled}
                className="btn btn-danger text-sm px-3 py-1"
              >
                {unlinking ? 'Unlinking...' : 'Yes, Unlink'}
              </button>
              <button
                onClick={() => setShowUnlinkConfirm(false)}
                disabled={unlinking || disabled}
                className="btn btn-secondary text-sm px-3 py-1"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowUnlinkConfirm(true)}
              disabled={disabled || isPrimary}
              className="p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isPrimary ? "Cannot unlink primary account" : "Unlink account"}
            >
              <XMarkIcon className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {isPrimary && (
        <div className="mt-4 p-3 bg-gold-500/10 border border-gold-500/30 rounded-lg">
          <p className="text-sm text-gold-300">
            This is your primary account. It will be used for notifications and default profile information.
            You must link another account before unlinking your primary account.
          </p>
        </div>
      )}
    </div>
  );
}

export default LinkedAccountCard;
