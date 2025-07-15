import React, { useState } from 'react';
import { Settings, Check, AlertCircle } from 'lucide-react';
import { useCounterStore } from '../stores/counterStore';

const CounterSetup: React.FC = () => {
  const { setupCounters } = useCounterStore();
  const [selectedCounters, setSelectedCounters] = useState<string[]>([]);
  const [prefixes, setPrefixes] = useState<{ [key: string]: string }>({});
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isLoading, setIsLoading] = useState(false);

  const availableCounters = Array.from({ length: 10 }, (_, i) => ({
    id: `counter${i + 1}`,
    name: `Counter ${i + 1}`,
  }));

  const handleCounterToggle = (counterId: string) => {
    setSelectedCounters(prev => {
      const isSelected = prev.includes(counterId);
      if (isSelected) {
        // Remove counter and its prefix
        const newPrefixes = { ...prefixes };
        delete newPrefixes[counterId];
        setPrefixes(newPrefixes);
        return prev.filter(id => id !== counterId);
      } else {
        // Add counter (max 7)
        if (prev.length >= 7) {
          return prev;
        }
        return [...prev, counterId];
      }
    });
  };

  const handlePrefixChange = (counterId: string, value: string) => {
    const upperValue = value.toUpperCase();
    setPrefixes(prev => ({
      ...prev,
      [counterId]: upperValue,
    }));

    // Clear error when user starts typing
    if (errors[counterId]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[counterId];
        return newErrors;
      });
    }
  };

  const validateSetup = () => {
    const newErrors: { [key: string]: string } = {};
    const usedPrefixes = new Set<string>();

    selectedCounters.forEach(counterId => {
      const prefix = prefixes[counterId] || '';
      
      // Check if prefix is empty
      if (!prefix) {
        newErrors[counterId] = 'Prefix required';
        return;
      }

      // Check prefix format
      if (!/^[A-Z0-9]{1,5}$/.test(prefix)) {
        newErrors[counterId] = 'Invalid format (A-Z, 0-9, max 5 chars)';
        return;
      }

      // Check uniqueness
      if (usedPrefixes.has(prefix)) {
        newErrors[counterId] = 'Prefix already used';
        return;
      }

      usedPrefixes.add(prefix);
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSetup = async () => {
    if (!validateSetup()) return;

    setIsLoading(true);
    
    // Simulate setup delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    const counterConfigs = selectedCounters.map(counterId => ({
      id: counterId,
      name: availableCounters.find(c => c.id === counterId)?.name || '',
      prefix: prefixes[counterId],
    }));

    setupCounters(counterConfigs);
    setIsLoading(false);
  };

  const isValid = selectedCounters.length > 0 && selectedCounters.length <= 7 && 
                  selectedCounters.every(id => prefixes[id] && /^[A-Z0-9]{1,5}$/.test(prefixes[id])) &&
                  new Set(selectedCounters.map(id => prefixes[id])).size === selectedCounters.length;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="w-16 h-16 bg-gradient-to-r from-indigo-600 to-purple-500 rounded-full flex items-center justify-center mx-auto">
          <Settings className="w-8 h-8 text-white" />
        </div>
        <h2 className="text-lg font-medium text-indigo-600">Activate Counters</h2>
        <p className="text-gray-600">Select and configure up to 7 counters</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Available Counters</span>
          <span className="text-sm text-gray-500">{selectedCounters.length}/7 selected</span>
        </div>

        <div className="space-y-3 max-h-96 overflow-y-auto">
          {availableCounters.map(counter => {
            const isSelected = selectedCounters.includes(counter.id);
            const canSelect = selectedCounters.length < 7 || isSelected;

            return (
              <div key={counter.id} className="space-y-2">
                <label className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                  canSelect ? 'hover:bg-gray-50' : 'opacity-50 cursor-not-allowed'
                }`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => canSelect && handleCounterToggle(counter.id)}
                    className="w-5 h-5 text-purple-600 rounded focus:ring-purple-500"
                    disabled={!canSelect}
                  />
                  <span className="text-gray-700 font-medium">{counter.name}</span>
                </label>

                {isSelected && (
                  <div className="ml-8 space-y-1">
                    <input
                      type="text"
                      value={prefixes[counter.id] || ''}
                      onChange={(e) => handlePrefixChange(counter.id, e.target.value)}
                      placeholder="Prefix (A-Z, 0-9)"
                      className={`w-full p-3 border rounded-lg focus:ring-2 focus:ring-purple-400 focus:border-transparent ${
                        errors[counter.id] ? 'border-red-500' : 'border-gray-300'
                      }`}
                      maxLength={5}
                    />
                    {errors[counter.id] && (
                      <div className="flex items-center gap-1 text-sm text-red-500">
                        <AlertCircle className="w-4 h-4" />
                        {errors[counter.id]}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <button
        onClick={handleSetup}
        disabled={!isValid || isLoading}
        className="w-full py-3 bg-gradient-to-r from-purple-600 to-purple-400 text-white font-semibold rounded-xl shadow-lg hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 flex items-center justify-center gap-2"
      >
        {isLoading ? (
          <>
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            Setting up counters...
          </>
        ) : (
          <>
            <Check className="w-5 h-5" />
            Setup Counters
          </>
        )}
      </button>
    </div>
  );
};

export default CounterSetup;