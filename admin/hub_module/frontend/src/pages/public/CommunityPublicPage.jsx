import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { publicApi } from '../../services/api';

function CommunityPublicPage() {
  const { id } = useParams();
  const [community, setCommunity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
          <Link to="/login" className="btn btn-primary mt-4 md:mt-0">
            Join Community
          </Link>
        </div>

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
    </div>
  );
}

export default CommunityPublicPage;
