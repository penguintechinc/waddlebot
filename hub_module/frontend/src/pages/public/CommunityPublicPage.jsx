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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto px-4 py-20 text-center">
        <div className="text-6xl mb-4">😔</div>
        <h1 className="text-2xl font-bold mb-2">Community Not Found</h1>
        <p className="text-slate-600 mb-6">{error}</p>
        <Link to="/communities" className="btn btn-primary">
          Browse Communities
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Banner */}
      <div className="h-48 bg-gradient-to-r from-primary-600 to-primary-800 relative">
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
        <div className="relative -mt-16 flex flex-col md:flex-row md:items-end md:space-x-6 pb-6 border-b border-slate-200">
          <div className="w-32 h-32 rounded-xl bg-white shadow-lg flex items-center justify-center overflow-hidden">
            {community.logoUrl ? (
              <img src={community.logoUrl} alt={community.displayName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-5xl">🐧</span>
            )}
          </div>
          <div className="mt-4 md:mt-0 flex-1">
            <h1 className="text-3xl font-bold">{community.displayName}</h1>
            <p className="text-slate-600 mt-1">{community.description || 'No description'}</p>
            <div className="flex items-center space-x-4 mt-3 text-sm text-slate-500">
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
          <h2 className="text-xl font-semibold mb-4">About</h2>
          <div className="card p-6">
            <p className="text-slate-600">
              {community.description || 'This community has not added a description yet.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CommunityPublicPage;
