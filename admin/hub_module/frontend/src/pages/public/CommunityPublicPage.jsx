import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { publicApi, communityApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

function CommunityPublicPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [community, setCommunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [joining, setJoining] = useState(false);
  const [joinMessage, setJoinMessage] = useState('');
  const [joinResult, setJoinResult] = useState(null);
  const [showJoinModal, setShowJoinModal] = useState(false);

  useEffect(() => {
    async function fetchCommunity() {
      try {
        const response = await publicApi.getCommunity(id);
        setCommunity(response.data.community);
      } catch (err) {
        setError(err.response?.data?.error || 'Community not found');
      } finally {
        setLoading(false);
      }
    }
    fetchCommunity();
  }, [id]);

  const handleJoin = async () => {
    if (!isAuthenticated) {
      navigate('/login', { state: { returnTo: `/communities/${id}` } });
      return;
    }

    setJoining(true);
    setJoinResult(null);

    try {
      const response = await communityApi.join(id, joinMessage);
      setJoinResult(response.data);
      setShowJoinModal(false);

      if (response.data.joined) {
        // Redirect to dashboard after successful join
        setTimeout(() => navigate(`/dashboard/community/${id}`), 1500);
      }
    } catch (err) {
      setJoinResult({
        success: false,
        message: err.response?.data?.error?.message || 'Failed to join community',
      });
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto px-4 py-20 text-center">
        <div className="text-6xl mb-4">😔</div>
        <h1 className="text-2xl font-bold mb-2 text-sky-100">Community Not Found</h1>
        <p className="text-navy-400 mb-6">{error}</p>
        <Link to="/communities" className="btn btn-primary">
          Browse Communities
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Banner */}
      <div className="h-48 bg-gradient-to-r from-navy-800 via-sky-900 to-navy-800 relative">
        {community.bannerUrl && (
          <img
            src={community.bannerUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* Header */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative -mt-16 flex flex-col md:flex-row md:items-end md:space-x-6 pb-6 border-b border-navy-700">
          <div className="w-32 h-32 rounded-xl bg-navy-800 shadow-lg flex items-center justify-center overflow-hidden border border-navy-600">
            {community.logoUrl ? (
              <img src={community.logoUrl} alt={community.displayName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-5xl">🐧</span>
            )}
          </div>
          <div className="mt-4 md:mt-0 flex-1">
            <h1 className="text-3xl font-bold text-sky-100">{community.displayName}</h1>
            <p className="text-navy-400 mt-1">{community.description || 'No description'}</p>
            <div className="flex items-center space-x-4 mt-3 text-sm text-navy-500">
              <span>{community.memberCount} members</span>
              <span>Since {new Date(community.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
          <button
            onClick={() => community.joinMode === 'approval' ? setShowJoinModal(true) : handleJoin()}
            disabled={joining}
            className="btn btn-primary mt-4 md:mt-0 disabled:opacity-50"
          >
            {joining ? 'Joining...' : community.joinMode === 'approval' ? 'Request to Join' : 'Join Community'}
          </button>
        </div>

        {/* Join Result Message */}
        {joinResult && (
          <div className={`mt-4 p-4 rounded-lg ${joinResult.success ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'}`}>
            {joinResult.message}
          </div>
        )}

        {/* Content */}
        <div className="py-8">
          <h2 className="text-xl font-semibold mb-4 text-sky-100">About</h2>
          <div className="card p-6">
            <p className="text-navy-400">
              {community.description || 'This community has not added a description yet.'}
            </p>
          </div>
        </div>
      </div>

      {/* Join Request Modal */}
      {showJoinModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full p-6">
            <h3 className="text-xl font-semibold mb-4 text-sky-100">Request to Join</h3>
            <p className="text-navy-400 mb-4">
              This community requires approval to join. You can include a message with your request.
            </p>
            <textarea
              value={joinMessage}
              onChange={(e) => setJoinMessage(e.target.value)}
              placeholder="Tell the admins why you want to join... (optional)"
              className="w-full p-3 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 placeholder-navy-500 focus:border-sky-500 focus:outline-none mb-4"
              rows={3}
            />
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowJoinModal(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleJoin}
                disabled={joining}
                className="btn btn-primary disabled:opacity-50"
              >
                {joining ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CommunityPublicPage;
