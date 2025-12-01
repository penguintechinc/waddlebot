import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

function PublicLayout() {
  const { user, isAuthenticated, logout } = useAuth();
  const location = useLocation();

  const navLinks = [
    { to: '/', label: 'Home' },
    { to: '/communities', label: 'Communities' },
    { to: '/live', label: 'Live Streams' },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            {/* Logo */}
            <div className="flex items-center">
              <Link to="/" className="flex items-center space-x-2">
                <span className="text-2xl">🐧</span>
                <span className="text-xl font-bold text-slate-900">WaddleBot</span>
              </Link>
            </div>

            {/* Navigation */}
            <div className="hidden md:flex items-center space-x-8">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`text-sm font-medium transition-colors ${
                    location.pathname === link.to
                      ? 'text-primary-600'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            {/* Auth buttons */}
            <div className="flex items-center space-x-4">
              {isAuthenticated ? (
                <>
                  <Link
                    to="/dashboard"
                    className="text-sm font-medium text-slate-600 hover:text-slate-900"
                  >
                    Dashboard
                  </Link>
                  {user?.roles?.includes('platform-admin') && (
                    <Link
                      to="/platform"
                      className="text-sm font-medium text-waddle-orange hover:text-orange-600"
                    >
                      Admin
                    </Link>
                  )}
                  <button
                    onClick={logout}
                    className="text-sm font-medium text-slate-600 hover:text-slate-900"
                  >
                    Logout
                  </button>
                  <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
                    {user?.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.username}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <span className="text-primary-600 font-medium">
                        {user?.username?.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <Link to="/login" className="btn btn-primary">
                  Sign In
                </Link>
              )}
            </div>
          </div>
        </nav>
      </header>

      {/* Main content */}
      <main className="flex-1">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 text-slate-400 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <div className="flex items-center space-x-2 mb-4">
                <span className="text-2xl">🐧</span>
                <span className="text-lg font-bold text-white">WaddleBot</span>
              </div>
              <p className="text-sm">
                Multi-platform community management for Discord, Twitch, and Slack.
              </p>
            </div>
            <div>
              <h4 className="text-white font-medium mb-4">Platform</h4>
              <ul className="space-y-2 text-sm">
                <li><Link to="/communities" className="hover:text-white">Communities</Link></li>
                <li><Link to="/live" className="hover:text-white">Live Streams</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-medium mb-4">Resources</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="https://docs.waddlebot.io" className="hover:text-white">Documentation</a></li>
                <li><a href="https://github.com/penguintech-io/waddlebot" className="hover:text-white">GitHub</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-medium mb-4">Company</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="https://penguintech.io" className="hover:text-white">PenguinTech</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-800 mt-8 pt-8 text-sm text-center">
            &copy; {new Date().getFullYear()} PenguinTech. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

export default PublicLayout;
