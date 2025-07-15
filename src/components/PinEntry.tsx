import React, { useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

const PinEntry: React.FC = () => {
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    // Simulate loading delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    const success = login(pin);
    if (!success) {
      setError('❌ Incorrect PIN');
      setPin('');
    }
    setIsLoading(false);
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="w-16 h-16 bg-gradient-to-r from-purple-600 to-indigo-500 rounded-full flex items-center justify-center mx-auto">
          <Lock className="w-8 h-8 text-white" />
        </div>
        <h2 className="text-xl font-semibold text-gray-800">Enter Counter PIN</h2>
        <p className="text-gray-600">Access required for counter management</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="relative">
          <input
            type={showPin ? 'text' : 'password'}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-400 focus:border-transparent text-center text-lg tracking-wider"
            placeholder="Enter PIN"
            maxLength={4}
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={() => setShowPin(!showPin)}
            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
          >
            {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-500 text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={pin.length !== 4 || isLoading}
          className="w-full py-3 bg-gradient-to-r from-purple-600 to-purple-400 text-white font-semibold rounded-xl shadow-lg hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Verifying...
            </>
          ) : (
            'Access Counter Panel'
          )}
        </button>
      </form>
    </div>
  );
};

export default PinEntry;