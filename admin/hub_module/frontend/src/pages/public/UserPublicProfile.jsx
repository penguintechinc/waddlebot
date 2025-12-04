import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { userApi } from '../../services/api';
import {
  UserCircleIcon,
  MapPinIcon,
  CalendarIcon,
  UsersIcon,
  ChartBarIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline';

const PLATFORM_INFO = {
  twitch: { color: '#9146FF', name: 'Twitch' },
  discord: { color: '#5865F2', name: 'Discord' },
  slack: { color: '#4A154B', name: 'Slack' },
  youtube: { color: '#FF0000', name: 'YouTube' },
  twitter: { color: '#1DA1F2', name: 'Twitter/X' },
  kick: { color: '#53FC18', name: 'Kick' },
};

function UserPublicProfile() {
  const { userId } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadProfile();
  }, [userId]);

  async function loadProfile() {
    try {
      setLoading(true);
      setError(null);
      const response = await userApi.getPublicProfile(userId);
      if (response.data.success) {
        setProfile(response.data.profile);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
      if (err.response?.status === 404) {
        setError('User not found');
      } else if (err.response?.status === 403) {
        setError('restricted');
      } else {
        setError('Failed to load profile');
      }
    } finally {
      setLoading(false);
    }
  }

  function formatLocation() {
    const parts = [];
    if (profile.locationCity) parts.push(profile.locationCity);
    if (profile.locationState) parts.push(profile.locationState);
    if (profile.locationCountry) parts.push(profile.locationCountry);
    return parts.join(', ');
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error === 'restricted') {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card p-12 text-center">
          <LockClosedIcon className="w-16 h-16 mx-auto text-slate-400 mb-4" />
          <h2 className="text-xl font-semibold mb-2">Profile Restricted</h2>
          <p className="text-slate-600">
            This user has restricted who can view their profile.
          </p>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="card p-12 text-center">
          <UserCircleIcon className="w-16 h-16 mx-auto text-slate-400 mb-4" />
          <h2 className="text-xl font-semibold mb-2">{error || 'Profile not found'}</h2>
          <Link to="/" className="text-primary-600 hover:text-primary-700">
            Go back home
          </Link>
        </div>
      </div>
    );
  }

  const location = formatLocation();

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="card overflow-hidden">
        {/* Banner placeholder */}
        <div className="h-32 bg-gradient-to-r from-primary-500 to-primary-700"></div>

        {/* Profile info */}
        <div className="px-6 pb-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4 -mt-12">
            {/* Avatar */}
            <div className="shrink-0">
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={profile.displayName || profile.username}
                  className="w-24 h-24 rounded-full border-4 border-white object-cover bg-white"
                />
              ) : (
                <div className="w-24 h-24 rounded-full border-4 border-white bg-slate-200 flex items-center justify-center">
                  <UserCircleIcon className="w-16 h-16 text-slate-400" />
                </div>
              )}
            </div>

            {/* Name and username */}
            <div className="flex-1 min-w-0 pt-2 sm:pt-0">
              <h1 className="text-2xl font-bold truncate">
                {profile.displayName || profile.username}
              </h1>
              {profile.displayName && (
                <p className="text-slate-600">@{profile.username}</p>
              )}
            </div>
          </div>

          {/* Bio */}
          {profile.bio && (
            <p className="mt-4 text-slate-700 whitespace-pre-wrap">{profile.bio}</p>
          )}

          {/* Meta info */}
          <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-600">
            {location && (
              <div className="flex items-center gap-1">
                <MapPinIcon className="w-4 h-4" />
                {location}
              </div>
            )}
            {profile.createdAt && (
              <div className="flex items-center gap-1">
                <CalendarIcon className="w-4 h-4" />
                Joined {new Date(profile.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Linked Platforms */}
      {profile.linkedPlatforms?.length > 0 && (
        <div className="card p-6 mt-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <UsersIcon className="w-5 h-5" />
            Linked Platforms
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {profile.linkedPlatforms.map((platform) => {
              const info = PLATFORM_INFO[platform.platform] || { color: '#6B7280', name: platform.platform };
              return (
                <div
                  key={platform.platform}
                  className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg"
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
                    style={{ backgroundColor: info.color }}
                  >
                    {info.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{info.name}</div>
                    <div className="text-sm text-slate-600 truncate">{platform.platformUsername}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Activity Stats */}
      {profile.showActivity && profile.activityStats && (
        <div className="card p-6 mt-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <ChartBarIcon className="w-5 h-5" />
            Activity
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {profile.activityStats.totalWatchTime !== undefined && (
              <div className="text-center">
                <div className="text-2xl font-bold text-primary-600">
                  {Math.floor(profile.activityStats.totalWatchTime / 60)}h
                </div>
                <div className="text-sm text-slate-600">Watch Time</div>
              </div>
            )}
            {profile.activityStats.totalMessages !== undefined && (
              <div className="text-center">
                <div className="text-2xl font-bold text-primary-600">
                  {profile.activityStats.totalMessages.toLocaleString()}
                </div>
                <div className="text-sm text-slate-600">Messages</div>
              </div>
            )}
            {profile.activityStats.communitiesJoined !== undefined && (
              <div className="text-center">
                <div className="text-2xl font-bold text-primary-600">
                  {profile.activityStats.communitiesJoined}
                </div>
                <div className="text-sm text-slate-600">Communities</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Communities */}
      {profile.showCommunities && profile.communities?.length > 0 && (
        <div className="card p-6 mt-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <UsersIcon className="w-5 h-5" />
            Communities
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {profile.communities.map((community) => (
              <Link
                key={community.id}
                to={`/communities/${community.id}`}
                className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
              >
                {community.logoUrl ? (
                  <img
                    src={community.logoUrl}
                    alt={community.name}
                    className="w-10 h-10 rounded-lg object-cover"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-primary-100 flex items-center justify-center">
                    <UsersIcon className="w-5 h-5 text-primary-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{community.displayName || community.name}</div>
                  <div className="text-sm text-slate-600">{community.role}</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default UserPublicProfile;
