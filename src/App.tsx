import React, { useState, useEffect } from 'react';
import { Lock, Settings, Play, SkipForward, RotateCcw, Plus, X, Check, Loader2 } from 'lucide-react';
import { useCounterStore } from './stores/counterStore';
import { useAuthStore } from './stores/authStore';
import PinEntry from './components/PinEntry';
import CounterSetup from './components/CounterSetup';
import CounterDashboard from './components/CounterDashboard';

function App() {
  const { isAuthenticated } = useAuthStore();
  const { counters, hasSetup } = useCounterStore();

  const showSetup = isAuthenticated && !hasSetup;
  const showDashboard = isAuthenticated && hasSetup;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 flex flex-col items-center p-4 font-inter">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-gradient-to-r from-purple-600 to-indigo-500 rounded-full flex items-center justify-center mx-auto">
            <Settings className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-indigo-800">Queue Joy</h1>
          <p className="text-gray-600">Counter Management Panel</p>
        </div>

        {/* Content */}
        {!isAuthenticated && <PinEntry />}
        {showSetup && <CounterSetup />}
        {showDashboard && <CounterDashboard />}
      </div>
    </div>
  );
}

export default App;