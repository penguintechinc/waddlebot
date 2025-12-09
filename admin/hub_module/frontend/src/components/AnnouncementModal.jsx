/**
 * Announcement Modal Component
 * Modal for creating/editing announcements with platform broadcast capabilities
 */
import { useState, useEffect } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

export default function AnnouncementModal({
  isOpen,
  onClose,
  onSave,
  announcement,
  connectedPlatforms
}) {
  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [announcementType, setAnnouncementType] = useState('general');
  const [isPinned, setIsPinned] = useState(false);
  const [broadcastToPlatforms, setBroadcastToPlatforms] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState([]);
  const [saving, setSaving] = useState(false);

  // Validation state
  const [errors, setErrors] = useState({});

  // Initialize form when modal opens or announcement changes
  useEffect(() => {
    if (isOpen) {
      if (announcement) {
        // Edit mode
        setTitle(announcement.title || '');
        setContent(announcement.content || '');
        setAnnouncementType(announcement.announcement_type || 'general');
        setIsPinned(announcement.is_pinned || false);
        setBroadcastToPlatforms(announcement.broadcast_to_platforms || false);
        setSelectedPlatforms(announcement.selected_platforms || []);
      } else {
        // Create mode
        setTitle('');
        setContent('');
        setAnnouncementType('general');
        setIsPinned(false);
        setBroadcastToPlatforms(false);
        setSelectedPlatforms([]);
      }
      setErrors({});
    }
  }, [isOpen, announcement]);

  // Validate form
  const validateForm = () => {
    const newErrors = {};

    if (!title.trim()) {
      newErrors.title = 'Title is required';
    }

    if (!content.trim()) {
      newErrors.content = 'Content is required';
    }

    if (broadcastToPlatforms && selectedPlatforms.length === 0) {
      newErrors.platforms = 'Please select at least one platform to broadcast to';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle platform selection
  const togglePlatform = (platform) => {
    setSelectedPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    );
  };

  // Handle save
  const handleSave = async (status) => {
    if (!validateForm()) {
      return;
    }

    setSaving(true);
    try {
      const data = {
        title: title.trim(),
        content: content.trim(),
        announcement_type: announcementType,
        is_pinned: isPinned,
        status,
        broadcast_to_platforms: broadcastToPlatforms,
        selected_platforms: selectedPlatforms
      };

      await onSave(data);
      onClose();
    } catch (error) {
      console.error('Error saving announcement:', error);
      setErrors({ submit: 'Failed to save announcement. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  const platformCount = selectedPlatforms.length;
  const canBroadcast = broadcastToPlatforms && platformCount > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-navy-800 rounded-lg max-w-lg w-full mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-navy-700">
          <h2 className="text-xl font-semibold text-sky-100">
            {announcement ? 'Edit Announcement' : 'Create Announcement'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1 text-navy-400 hover:text-sky-100 hover:bg-navy-700 rounded-lg transition-colors disabled:opacity-50"
            aria-label="Close modal"
          >
            <XMarkIcon className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">
          {/* Title Field */}
          <div>
            <label className="block text-sm font-medium text-sky-100 mb-2">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (errors.title) setErrors({ ...errors, title: '' });
              }}
              maxLength={255}
              placeholder="Enter announcement title"
              disabled={saving}
              className="w-full bg-navy-700 border border-navy-600 text-sky-100 rounded-lg px-3 py-2
                         placeholder-navy-400 focus:outline-none focus:ring-2 focus:ring-gold-500
                         disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {errors.title && (
              <p className="text-red-400 text-sm mt-1">{errors.title}</p>
            )}
            <p className="text-xs text-navy-400 mt-1">{title.length}/255</p>
          </div>

          {/* Content Field */}
          <div>
            <label className="block text-sm font-medium text-sky-100 mb-2">
              Content <span className="text-red-400">*</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                if (errors.content) setErrors({ ...errors, content: '' });
              }}
              maxLength={2000}
              placeholder="Enter announcement content"
              disabled={saving}
              rows={6}
              className="w-full bg-navy-700 border border-navy-600 text-sky-100 rounded-lg px-3 py-2
                         placeholder-navy-400 focus:outline-none focus:ring-2 focus:ring-gold-500
                         disabled:opacity-50 disabled:cursor-not-allowed resize-none"
            />
            {errors.content && (
              <p className="text-red-400 text-sm mt-1">{errors.content}</p>
            )}
            <p className="text-xs text-navy-400 mt-1">{content.length}/2000</p>
          </div>

          {/* Type Dropdown */}
          <div>
            <label className="block text-sm font-medium text-sky-100 mb-2">
              Announcement Type
            </label>
            <select
              value={announcementType}
              onChange={(e) => setAnnouncementType(e.target.value)}
              disabled={saving}
              className="w-full bg-navy-700 border border-navy-600 text-sky-100 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-gold-500
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="general">General</option>
              <option value="important">Important</option>
              <option value="event">Event</option>
              <option value="update">Update</option>
            </select>
          </div>

          {/* Pin Checkbox */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={(e) => setIsPinned(e.target.checked)}
                disabled={saving}
                className="w-4 h-4 bg-navy-700 border border-navy-600 rounded
                           checked:bg-gold-500 checked:border-gold-500
                           focus:ring-2 focus:ring-gold-500 focus:ring-offset-0
                           disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="text-sm font-medium text-sky-100">Pin this announcement</span>
            </label>
          </div>

          {/* Broadcast Section */}
          <div className="pt-4 border-t border-navy-700">
            <label className="flex items-center gap-3 cursor-pointer mb-4">
              <input
                type="checkbox"
                checked={broadcastToPlatforms}
                onChange={(e) => {
                  setBroadcastToPlatforms(e.target.checked);
                  if (e.target.checked && errors.platforms) {
                    setErrors({ ...errors, platforms: '' });
                  }
                }}
                disabled={saving}
                className="w-4 h-4 bg-navy-700 border border-navy-600 rounded
                           checked:bg-gold-500 checked:border-gold-500
                           focus:ring-2 focus:ring-gold-500 focus:ring-offset-0
                           disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="text-sm font-medium text-sky-100">
                Broadcast to connected platforms
              </span>
            </label>

            {/* Platform Selection */}
            {broadcastToPlatforms && (
              <div className="ml-7 space-y-3">
                {connectedPlatforms.length > 0 ? (
                  <>
                    {connectedPlatforms.map(platform => (
                      <label
                        key={platform}
                        className="flex items-center gap-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedPlatforms.includes(platform)}
                          onChange={() => togglePlatform(platform)}
                          disabled={saving}
                          className="w-4 h-4 bg-navy-700 border border-navy-600 rounded
                                     checked:bg-gold-500 checked:border-gold-500
                                     focus:ring-2 focus:ring-gold-500 focus:ring-offset-0
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <span className="text-sm text-sky-200 capitalize">{platform}</span>
                      </label>
                    ))}

                    {/* Platform Count */}
                    <p className="text-xs text-navy-400 mt-3">
                      {platformCount === 0
                        ? 'Select at least one platform'
                        : `Will broadcast to ${platformCount} platform${platformCount === 1 ? '' : 's'}`}
                    </p>

                    {errors.platforms && (
                      <p className="text-red-400 text-sm mt-1">{errors.platforms}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-navy-400 italic">
                    No connected platforms available
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
              <p className="text-red-400 text-sm">{errors.submit}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-navy-700 bg-navy-850">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 bg-navy-700 hover:bg-navy-600 text-sky-100 rounded-lg
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                       font-medium text-sm"
          >
            Cancel
          </button>

          <button
            onClick={() => handleSave('draft')}
            disabled={saving}
            className="px-4 py-2 border border-navy-600 hover:border-sky-400 text-sky-100
                       hover:text-sky-100 rounded-lg transition-colors disabled:opacity-50
                       disabled:cursor-not-allowed font-medium text-sm"
          >
            {saving ? 'Saving...' : 'Save Draft'}
          </button>

          <button
            onClick={() => handleSave('published')}
            disabled={saving}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                       font-medium text-sm"
          >
            {saving ? 'Publishing...' : 'Publish'}
          </button>

          {canBroadcast && (
            <button
              onClick={() => handleSave('published')}
              disabled={saving}
              className="px-4 py-2 bg-gold-500 hover:bg-gold-600 text-navy-900 rounded-lg
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                         font-medium text-sm"
            >
              {saving ? 'Publishing...' : 'Publish & Broadcast'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
