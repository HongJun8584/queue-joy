import React, { useState } from 'react';
import { Play, SkipForward, RotateCcw, Edit2, Trash2, Plus, X, Check, AlertCircle } from 'lucide-react';
import { useCounterStore, Counter } from '../stores/counterStore';
import { useAuthStore } from '../stores/authStore';

const CounterDashboard: React.FC = () => {
  const { counters, callNext, skipNumber, resetCounter, updatePrefix, removeCounter } = useCounterStore();
  const { logout } = useAuthStore();
  const [editingCounter, setEditingCounter] = useState<string | null>(null);
  const [editPrefix, setEditPrefix] = useState('');
  const [loadingActions, setLoadingActions] = useState<{ [key: string]: boolean }>({});
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ [key: string]: { type: 'success' | 'error', message: string } }>({});

  const handleAction = async (counterId: string, action: string, callback: () => void) => {
    setLoadingActions(prev => ({ ...prev, [`${counterId}-${action}`]: true }));
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    callback();
    
    setLoadingActions(prev => ({ ...prev, [`${counterId}-${action}`]: false }));
    
    // Show feedback
    const counter = counters.find(c => c.id === counterId);
    if (counter) {
      let message = '';
      switch (action) {
        case 'call':
          message = `✅ ${counter.prefix}${counter.lastIssued + 1} called!`;
          break;
        case 'skip':
          message = `⏭️ Skipped to ${counter.prefix}${counter.nowServing + 1}`;
          break;
        case 'reset':
          message = `🔄 ${counter.name} reset to ${counter.prefix}1`;
          break;
      }
      
      setFeedback(prev => ({
        ...prev,
        [counterId]: { type: 'success', message }
      }));
      
      // Clear feedback after 3 seconds
      setTimeout(() => {
        setFeedback(prev => {
          const newFeedback = { ...prev };
          delete newFeedback[counterId];
          return newFeedback;
        });
      }, 3000);
    }
  };

  const handleEditPrefix = (counter: Counter) => {
    setEditingCounter(counter.id);
    setEditPrefix(counter.prefix);
  };

  const handleSavePrefix = async (counterId: string) => {
    if (!/^[A-Z0-9]{1,5}$/.test(editPrefix)) {
      setFeedback(prev => ({
        ...prev,
        [counterId]: { type: 'error', message: 'Invalid prefix format' }
      }));
      return;
    }

    // Check if prefix is unique
    const isUnique = !counters.some(c => c.id !== counterId && c.prefix === editPrefix);
    if (!isUnique) {
      setFeedback(prev => ({
        ...prev,
        [counterId]: { type: 'error', message: 'Prefix already in use' }
      }));
      return;
    }

    setLoadingActions(prev => ({ ...prev, [`${counterId}-edit`]: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    
    updatePrefix(counterId, editPrefix);
    setEditingCounter(null);
    setLoadingActions(prev => ({ ...prev, [`${counterId}-edit`]: false }));
    
    setFeedback(prev => ({
      ...prev,
      [counterId]: { type: 'success', message: `✅ Prefix updated to ${editPrefix}` }
    }));
  };

  const handleRemoveCounter = async (counterId: string) => {
    setLoadingActions(prev => ({ ...prev, [`${counterId}-remove`]: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    
    removeCounter(counterId);
    setConfirmRemove(null);
    setLoadingActions(prev => ({ ...prev, [`${counterId}-remove`]: false }));
  };

  const handleResetCounter = async (counterId: string) => {
    await handleAction(counterId, 'reset', () => resetCounter(counterId));
    setConfirmReset(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-indigo-600">Counter Dashboard</h2>
          <p className="text-sm text-gray-600">{counters.length} active counter{counters.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={logout}
          className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
        >
          Logout
        </button>
      </div>

      {/* Counters */}
      <div className="space-y-4">
        {counters.map(counter => (
          <div key={counter.id} className="bg-white rounded-xl shadow-lg p-4 space-y-4 border border-gray-100 hover:shadow-xl transition-shadow">
            {/* Counter Info */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{counter.name}</p>
                <div className="flex items-center gap-2">
                  {editingCounter === counter.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editPrefix}
                        onChange={(e) => setEditPrefix(e.target.value.toUpperCase())}
                        className="w-20 p-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-purple-400"
                        maxLength={5}
                      />
                      <button
                        onClick={() => handleSavePrefix(counter.id)}
                        disabled={loadingActions[`${counter.id}-edit`]}
                        className="p-1 bg-green-100 text-green-600 rounded hover:bg-green-200 transition-colors"
                      >
                        {loadingActions[`${counter.id}-edit`] ? (
                          <div className="w-4 h-4 border-2 border-green-600 border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <Check className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => setEditingCounter(null)}
                        className="p-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-3xl font-bold text-indigo-600">
                        {counter.prefix} {counter.nowServing}
                      </p>
                      <button
                        onClick={() => handleEditPrefix(counter)}
                        className="p-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Last Issued</p>
                <p className="text-lg font-semibold text-pink-500">{counter.prefix} {counter.lastIssued}</p>
              </div>
            </div>

            {/* Feedback */}
            {feedback[counter.id] && (
              <div className={`p-2 rounded-lg text-sm ${
                feedback[counter.id].type === 'success' 
                  ? 'bg-green-50 text-green-700' 
                  : 'bg-red-50 text-red-700'
              }`}>
                {feedback[counter.id].message}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => handleAction(counter.id, 'call', () => callNext(counter.id))}
                disabled={loadingActions[`${counter.id}-call`]}
                className="flex-1 py-2 bg-gradient-to-r from-purple-600 to-purple-400 text-white rounded-xl shadow hover:scale-105 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {loadingActions[`${counter.id}-call`] ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Call Next
              </button>
              
              <button
                onClick={() => handleAction(counter.id, 'skip', () => skipNumber(counter.id))}
                disabled={loadingActions[`${counter.id}-skip`] || counter.nowServing >= counter.lastIssued}
                className="flex-1 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loadingActions[`${counter.id}-skip`] ? (
                  <div className="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <SkipForward className="w-4 h-4" />
                )}
                Skip
              </button>
            </div>

            {/* Secondary Actions */}
            <div className="flex gap-2">
              {confirmReset === counter.id ? (
                <div className="flex-1 flex gap-2">
                  <button
                    onClick={() => handleResetCounter(counter.id)}
                    disabled={loadingActions[`${counter.id}-reset`]}
                    className="flex-1 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center gap-2"
                  >
                    {loadingActions[`${counter.id}-reset`] ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    Confirm Reset
                  </button>
                  <button
                    onClick={() => setConfirmReset(null)}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmReset(counter.id)}
                  className="flex-1 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors flex items-center justify-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
              )}

              {confirmRemove === counter.id ? (
                <div className="flex-1 flex gap-2">
                  <button
                    onClick={() => handleRemoveCounter(counter.id)}
                    disabled={loadingActions[`${counter.id}-remove`]}
                    className="flex-1 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center gap-2"
                  >
                    {loadingActions[`${counter.id}-remove`] ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    Confirm Remove
                  </button>
                  <button
                    onClick={() => setConfirmRemove(null)}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRemove(counter.id)}
                  className="flex-1 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add Counter Button */}
      {counters.length < 7 && (
        <button
          onClick={() => {
            // Reset to setup mode
            const { logout } = useAuthStore.getState();
            const { counters: currentCounters } = useCounterStore.getState();
            
            // Clear all counters to trigger setup mode
            useCounterStore.setState({ counters: [], hasSetup: false });
          }}
          className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-500 text-white font-semibold rounded-xl shadow-lg hover:scale-105 transition-all duration-300 flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Add More Counters
        </button>
      )}
    </div>
  );
};

export default CounterDashboard;