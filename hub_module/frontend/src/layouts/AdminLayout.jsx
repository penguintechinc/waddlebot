import { Outlet, Link, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  HomeIcon,
  UserGroupIcon,
  PuzzlePieceIcon,
  GlobeAltIcon,
  ComputerDesktopIcon,
  ChartBarIcon,
  DocumentTextIcon,
  ArrowLeftOnRectangleIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';

function AdminLayout() {
  const { user, logout, isPlatformAdmin } = useAuth();
  const location = useLocation();
  const { communityId } = useParams();

  // Community admin nav
  const communityAdminNav = communityId
    ? [
        { to: `/admin/${communityId}`, icon: HomeIcon, label: 'Overview', exact: true },
        { to: `/admin/${communityId}/members`, icon: UserGroupIcon, label: 'Members' },
        { to: `/admin/${communityId}/modules`, icon: PuzzlePieceIcon, label: 'Modules' },
        { to: `/admin/${communityId}/browser-sources`, icon: ComputerDesktopIcon, label: 'Browser Sources' },
        { to: `/admin/${communityId}/domains`, icon: GlobeAltIcon, label: 'Custom Domains' },
      ]
    : [];

  // Platform admin nav
  const platformAdminNav = [
    { to: '/platform', icon: ChartBarIcon, label: 'Dashboard', exact: true },
    { to: '/platform/users', icon: UserGroupIcon, label: 'Users' },
    { to: '/platform/communities', icon: HomeIcon, label: 'Communities' },
  ];

  const isActive = (to, exact = false) => {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  };

  const navItems = communityId ? communityAdminNav : platformAdminNav;
  const title = communityId ? 'Community Admin' : 'Platform Admin';

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Top bar */}
      <header className="bg-slate-900 text-white sticky top-0 z-50">
        <div className="flex justify-between items-center h-16 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4">
            <Link to="/" className="flex items-center space-x-2">
              <span className="text-2xl">🐧</span>
              <span className="text-xl font-bold">WaddleBot</span>
            </Link>
            <span className="text-slate-500">|</span>
            <div className="flex items-center space-x-2">
              <ShieldCheckIcon className="w-5 h-5 text-waddle-orange" />
              <span className="font-medium text-waddle-orange">{title}</span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <Link to="/dashboard" className="text-sm text-slate-300 hover:text-white">
              Back to Dashboard
            </Link>
            <div className="flex items-center space-x-2">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.username} className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center">
                  <span className="text-white font-medium">
                    {user?.username?.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <span className="text-sm text-slate-300">{user?.username}</span>
            </div>
            <button
              onClick={logout}
              className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"
            >
              <ArrowLeftOnRectangleIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-slate-800 min-h-[calc(100vh-4rem)] sticky top-16">
          <nav className="p-4 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center space-x-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive(item.to, item.exact)
                    ? 'bg-waddle-orange text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{item.label}</span>
              </Link>
            ))}

            {communityId && (
              <>
                <div className="pt-6 pb-2">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3">
                    Quick Actions
                  </div>
                </div>
                <Link
                  to={`/dashboard/community/${communityId}`}
                  className="flex items-center space-x-3 px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white"
                >
                  <DocumentTextIcon className="w-5 h-5" />
                  <span className="text-sm font-medium">View Community</span>
                </Link>
              </>
            )}

            {isPlatformAdmin && communityId && (
              <Link
                to="/platform"
                className="flex items-center space-x-3 px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white"
              >
                <ShieldCheckIcon className="w-5 h-5" />
                <span className="text-sm font-medium">Platform Admin</span>
              </Link>
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

export default AdminLayout;
