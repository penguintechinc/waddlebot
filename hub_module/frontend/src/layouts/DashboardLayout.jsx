import { Outlet, Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  HomeIcon,
  UserGroupIcon,
  CalendarIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  ArrowLeftOnRectangleIcon,
} from '@heroicons/react/24/outline';

function DashboardLayout() {
  const { user, logout, isPlatformAdmin, isSuperAdmin } = useAuth();
  const location = useLocation();
  const { id: communityId } = useParams();

  const mainNav = [
    { to: '/dashboard', icon: HomeIcon, label: 'My Communities' },
  ];

  const communityNav = communityId
    ? [
        { to: `/dashboard/community/${communityId}`, icon: HomeIcon, label: 'Overview' },
        { to: `/dashboard/community/${communityId}/settings`, icon: Cog6ToothIcon, label: 'Settings' },
      ]
    : [];

  return (
    <div className="min-h-screen bg-navy-950">
      {/* Top bar */}
      <header className="bg-navy-900 border-b border-navy-700 sticky top-0 z-50">
        <div className="flex justify-between items-center h-16 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center space-x-2">
            <span className="text-2xl">🐧</span>
            <span className="text-xl font-bold text-gold-400">WaddleBot</span>
          </Link>

          <div className="flex items-center space-x-4">
            {isSuperAdmin && (
              <Link
                to="/superadmin"
                className="text-sm font-medium text-gold-400 hover:text-gold-300"
              >
                Super Admin
              </Link>
            )}
            {isPlatformAdmin && (
              <Link
                to="/platform"
                className="text-sm font-medium text-gold-400 hover:text-gold-300"
              >
                Platform Admin
              </Link>
            )}
            <div className="flex items-center space-x-2">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.username} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center border border-navy-600">
                  <span className="text-sky-400 font-medium">
                    {user?.username?.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <span className="text-sm font-medium text-sky-100">{user?.username}</span>
            </div>
            <button
              onClick={logout}
              className="p-2 text-navy-400 hover:text-sky-300 rounded-lg hover:bg-navy-800"
            >
              <ArrowLeftOnRectangleIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-navy-900 border-r border-navy-700 min-h-[calc(100vh-4rem)] sticky top-16">
          <nav className="p-4 space-y-1">
            {mainNav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors ${
                  location.pathname === item.to
                    ? 'bg-navy-800 text-gold-400'
                    : 'text-navy-300 hover:bg-navy-800 hover:text-sky-300'
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            ))}

            {communityNav.length > 0 && (
              <>
                <div className="pt-4 pb-2">
                  <div className="text-xs font-semibold text-navy-500 uppercase tracking-wider px-3">
                    Community
                  </div>
                </div>
                {communityNav.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors ${
                      location.pathname === item.to
                        ? 'bg-navy-800 text-gold-400'
                        : 'text-navy-300 hover:bg-navy-800 hover:text-sky-300'
                    }`}
                  >
                    <item.icon className="w-5 h-5" />
                    <span className="text-sm font-medium">{item.label}</span>
                  </Link>
                ))}

                {/* Admin link */}
                <Link
                  to={`/admin/${communityId}`}
                  className="flex items-center space-x-3 px-3 py-2 rounded-lg text-gold-400 hover:bg-navy-800"
                >
                  <Cog6ToothIcon className="w-5 h-5" />
                  <span className="text-sm font-medium">Admin Panel</span>
                </Link>
              </>
            )}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
