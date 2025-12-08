import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';

const CATEGORIES = [
  { id: 'medieval', name: 'Medieval', icon: '⚔️', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  { id: 'space', name: 'Space', icon: '🚀', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  { id: 'pirate', name: 'Pirate', icon: '☠️', color: 'bg-orange-500/20 text-orange-300 border-orange-500/30' },
  { id: 'cyberpunk', name: 'Cyberpunk', icon: '🤖', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  { id: 'fantasy', name: 'Fantasy', icon: '🔮', color: 'bg-pink-500/20 text-pink-300 border-pink-500/30' },
];

const ITEM_TYPES = [
  { id: 'weapon', name: 'Weapon', icon: '⚔️' },
  { id: 'armor', name: 'Armor', icon: '🛡️' },
  { id: 'accessory', name: 'Accessory', icon: '💍' },
];

const RARITIES = [
  { id: 'common', name: 'Common', color: 'text-gray-400', bg: 'bg-gray-500/20', border: 'border-gray-500/30' },
  { id: 'uncommon', name: 'Uncommon', color: 'text-green-400', bg: 'bg-green-500/20', border: 'border-green-500/30' },
  { id: 'rare', name: 'Rare', color: 'text-blue-400', bg: 'bg-blue-500/20', border: 'border-blue-500/30' },
  { id: 'epic', name: 'Epic', color: 'text-purple-400', bg: 'bg-purple-500/20', border: 'border-purple-500/30' },
  { id: 'legendary', name: 'Legendary', color: 'text-orange-400', bg: 'bg-orange-500/20', border: 'border-orange-500/30' },
];

function LoyaltyGear() {
  const { communityId } = useParams();
  const [activeCategory, setActiveCategory] = useState('medieval');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    category: 'medieval',
    type: 'weapon',
    rarity: 'common',
    attack: 0,
    defense: 0,
    luck: 0,
    price: 0,
    description: '',
    isAvailable: true,
  });

  useEffect(() => {
    fetchData();
  }, [communityId, activeCategory]);

  async function fetchData() {
    setLoading(true);
    try {
      const [itemsRes, statsRes] = await Promise.all([
        api.get(`/api/v1/admin/${communityId}/loyalty/gear/items`, {
          params: { category: activeCategory }
        }),
        api.get(`/api/v1/admin/${communityId}/loyalty/gear/stats`)
      ]);

      if (itemsRes.data.success) {
        setItems(itemsRes.data.items || []);
      }
      if (statsRes.data.success) {
        setStats(statsRes.data.stats || {});
      }
    } catch (err) {
      console.error('Failed to fetch gear data:', err);
      setMessage({ type: 'error', text: 'Failed to load gear data' });
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setFormData({
      name: '',
      category: activeCategory,
      type: 'weapon',
      rarity: 'common',
      attack: 0,
      defense: 0,
      luck: 0,
      price: 0,
      description: '',
      isAvailable: true,
    });
    setShowAddForm(false);
    setEditingItem(null);
  }

  async function handleCreateItem() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await api.post(
        `/api/v1/admin/${communityId}/loyalty/gear/items`,
        formData
      );
      if (response.data.success) {
        setMessage({ type: 'success', text: 'Item created successfully' });
        resetForm();
        fetchData();
      }
    } catch (err) {
      console.error('Failed to create item:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to create item' });
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateItem() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await api.put(
        `/api/v1/admin/${communityId}/loyalty/gear/items/${editingItem.id}`,
        formData
      );
      if (response.data.success) {
        setMessage({ type: 'success', text: 'Item updated successfully' });
        resetForm();
        fetchData();
      }
    } catch (err) {
      console.error('Failed to update item:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to update item' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteItem() {
    setSaving(true);
    setMessage(null);
    try {
      await api.delete(
        `/api/v1/admin/${communityId}/loyalty/gear/items/${editingItem.id}`
      );
      setMessage({ type: 'success', text: 'Item deleted successfully' });
      setShowDeleteConfirm(false);
      resetForm();
      fetchData();
    } catch (err) {
      console.error('Failed to delete item:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to delete item' });
    } finally {
      setSaving(false);
    }
  }

  async function toggleAvailability(item) {
    try {
      await api.put(
        `/api/v1/admin/${communityId}/loyalty/gear/items/${item.id}`,
        { ...item, isAvailable: !item.isAvailable }
      );
      fetchData();
    } catch (err) {
      console.error('Failed to toggle availability:', err);
      setMessage({ type: 'error', text: 'Failed to update item availability' });
    }
  }

  function startEdit(item) {
    setEditingItem(item);
    setFormData({
      name: item.name,
      category: item.category,
      type: item.type,
      rarity: item.rarity,
      attack: item.attack || 0,
      defense: item.defense || 0,
      luck: item.luck || 0,
      price: item.price || 0,
      description: item.description || '',
      isAvailable: item.isAvailable !== false,
    });
  }

  function getRarityInfo(rarityId) {
    return RARITIES.find(r => r.id === rarityId) || RARITIES[0];
  }

  function getTypeIcon(typeId) {
    return ITEM_TYPES.find(t => t.id === typeId)?.icon || '❓';
  }

  if (loading && !items.length) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-sky-100">Loyalty Gear Management</h1>
          <p className="text-navy-400 mt-1">Manage gear items for duels and combat</p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="btn btn-primary"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add New Item
        </button>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg border ${
          message.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            : 'bg-red-500/20 text-red-300 border-red-500/30'
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">×</button>
        </div>
      )}

      {/* Gear Stats Overview */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="card p-4">
            <div className="text-navy-400 text-sm">Total Items</div>
            <div className="text-2xl font-bold text-sky-100 mt-1">{stats.totalItems || 0}</div>
          </div>
          <div className="card p-4">
            <div className="text-navy-400 text-sm">Items Distributed</div>
            <div className="text-2xl font-bold text-green-400 mt-1">{stats.itemsDistributed || 0}</div>
          </div>
          <div className="card p-4">
            <div className="text-navy-400 text-sm">Most Owned</div>
            <div className="text-lg font-bold text-purple-400 mt-1 truncate">
              {stats.mostOwned?.name || 'N/A'}
            </div>
          </div>
          <div className="card p-4">
            <div className="text-navy-400 text-sm">Rarest Item</div>
            <div className="text-lg font-bold text-orange-400 mt-1 truncate">
              {stats.rarestItem?.name || 'N/A'}
            </div>
          </div>
        </div>
      )}

      {/* Rarity Legend */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-semibold text-navy-300 mb-3">Rarity Legend</h3>
        <div className="flex flex-wrap gap-4">
          {RARITIES.map((rarity) => (
            <div key={rarity.id} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${rarity.bg} border ${rarity.border}`}></div>
              <span className={`text-sm ${rarity.color} font-medium`}>{rarity.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-2 mb-6 overflow-x-auto">
        {CATEGORIES.map((category) => (
          <button
            key={category.id}
            onClick={() => setActiveCategory(category.id)}
            className={`px-4 py-2 rounded-lg border transition-all whitespace-nowrap ${
              activeCategory === category.id
                ? category.color
                : 'bg-navy-800 text-navy-400 border-navy-700 hover:border-navy-500'
            }`}
          >
            <span className="mr-2">{category.icon}</span>
            {category.name}
          </button>
        ))}
      </div>

      {/* Items Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-navy-800">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Item
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Rarity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Stats
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Price
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Available
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-navy-300 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {items.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-6 py-8 text-center text-navy-400">
                    No items in this category yet
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const rarity = getRarityInfo(item.rarity);
                  return (
                    <tr key={item.id} className="hover:bg-navy-800/50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="text-xl mr-2">{getTypeIcon(item.type)}</span>
                          <div>
                            <div className="text-sm font-medium text-sky-100">{item.name}</div>
                            {item.description && (
                              <div className="text-xs text-navy-400 truncate max-w-xs">
                                {item.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-navy-300 capitalize">{item.type}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${rarity.bg} ${rarity.color} border ${rarity.border}`}>
                          {rarity.name}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex gap-3 text-xs">
                          {item.attack > 0 && (
                            <span className="text-red-400" title="Attack">⚔️ {item.attack}</span>
                          )}
                          {item.defense > 0 && (
                            <span className="text-blue-400" title="Defense">🛡️ {item.defense}</span>
                          )}
                          {item.luck > 0 && (
                            <span className="text-green-400" title="Luck">🍀 {item.luck}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gold-400 font-semibold">{item.price}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button
                          onClick={() => toggleAvailability(item)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            item.isAvailable !== false ? 'bg-green-500' : 'bg-navy-600'
                          }`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            item.isAvailable !== false ? 'translate-x-6' : 'translate-x-1'
                          }`} />
                        </button>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <button
                          onClick={() => startEdit(item)}
                          className="text-sky-400 hover:text-sky-300"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {(showAddForm || editingItem) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-navy-900 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-navy-700 flex items-center justify-between">
              <h2 className="text-xl font-bold text-sky-100">
                {editingItem ? 'Edit Item' : 'Add New Item'}
              </h2>
              <button
                onClick={resetForm}
                className="text-navy-400 hover:text-sky-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">
                  Item Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  placeholder="e.g., Excalibur, Laser Rifle, Hook Hand"
                />
              </div>

              {/* Category and Type */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Category *
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.icon} {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Type *
                  </label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  >
                    {ITEM_TYPES.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.icon} {type.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Rarity and Price */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Rarity *
                  </label>
                  <select
                    value={formData.rarity}
                    onChange={(e) => setFormData({ ...formData, rarity: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  >
                    {RARITIES.map((rarity) => (
                      <option key={rarity.id} value={rarity.id}>
                        {rarity.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Price (Currency) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Attack Bonus
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.attack}
                    onChange={(e) => setFormData({ ...formData, attack: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Defense Bonus
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.defense}
                    onChange={(e) => setFormData({ ...formData, defense: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Luck Bonus
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.luck}
                    onChange={(e) => setFormData({ ...formData, luck: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows="3"
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  placeholder="A legendary sword forged in dragon fire..."
                />
              </div>

              {/* Available Toggle */}
              <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
                <div>
                  <div className="font-medium text-sky-100">Available for Purchase</div>
                  <div className="text-sm text-navy-400">Allow users to buy this item</div>
                </div>
                <input
                  type="checkbox"
                  checked={formData.isAvailable}
                  onChange={(e) => setFormData({ ...formData, isAvailable: e.target.checked })}
                  className="w-5 h-5 rounded border-navy-600 text-sky-500 focus:ring-sky-500"
                />
              </label>
            </div>

            <div className="p-6 border-t border-navy-700 flex gap-3 justify-between">
              <div>
                {editingItem && (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={saving}
                    className="px-4 py-2 bg-red-500/20 text-red-300 border border-red-500/30 rounded-lg hover:bg-red-500/30 disabled:opacity-50"
                  >
                    Delete Item
                  </button>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={resetForm}
                  disabled={saving}
                  className="px-4 py-2 bg-navy-700 text-navy-300 rounded-lg hover:bg-navy-600 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={editingItem ? handleUpdateItem : handleCreateItem}
                  disabled={saving || !formData.name.trim()}
                  className="px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : (editingItem ? 'Update Item' : 'Create Item')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-navy-900 rounded-lg max-w-md w-full">
            <div className="p-6">
              <h3 className="text-xl font-bold text-sky-100 mb-4">Confirm Delete</h3>
              <p className="text-navy-300 mb-6">
                Are you sure you want to delete "{editingItem?.name}"? This action cannot be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={saving}
                  className="px-4 py-2 bg-navy-700 text-navy-300 rounded-lg hover:bg-navy-600 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteItem}
                  disabled={saving}
                  className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                >
                  {saving ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LoyaltyGear;
