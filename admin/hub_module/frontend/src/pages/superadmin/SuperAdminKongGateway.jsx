import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import KongServices from './kong/KongServices';
import KongRoutes from './kong/KongRoutes';
import KongPlugins from './kong/KongPlugins';
import KongConsumers from './kong/KongConsumers';
import KongUpstreams from './kong/KongUpstreams';
import KongCertificates from './kong/KongCertificates';
import KongRateLimiting from './kong/KongRateLimiting';

const TABS = [
  { id: 'services', label: 'Services', icon: '🔧' },
  { id: 'routes', label: 'Routes', icon: '🛣️' },
  { id: 'plugins', label: 'Plugins', icon: '🔌' },
  { id: 'consumers', label: 'Consumers', icon: '👥' },
  { id: 'upstreams', label: 'Upstreams', icon: '⬆️' },
  { id: 'certificates', label: 'Certificates', icon: '🔐' },
  { id: 'rate-limiting', label: 'Rate Limiting', icon: '⏱️' },
];

export default function SuperAdminKongGateway() {
  const [activeTab, setActiveTab] = useState('services');

  const renderTabContent = () => {
    switch (activeTab) {
      case 'services':
        return <KongServices />;
      case 'routes':
        return <KongRoutes />;
      case 'plugins':
        return <KongPlugins />;
      case 'consumers':
        return <KongConsumers />;
      case 'upstreams':
        return <KongUpstreams />;
      case 'certificates':
        return <KongCertificates />;
      case 'rate-limiting':
        return <KongRateLimiting />;
      default:
        return <KongServices />;
    }
  };

  return (
    <div className="min-h-screen bg-navy-950 text-white p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-sky-400 mb-2">Kong Gateway</h1>
          <p className="text-gray-400">Manage API gateway configuration, routes, plugins, and security</p>
        </div>

        {/* Tabs */}
        <div className="mb-6 border-b border-navy-800 flex overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-6 py-4 font-semibold whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-sky-400 text-sky-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <span className="mr-2">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {renderTabContent()}
        </div>
      </div>
    </div>
  );
}
