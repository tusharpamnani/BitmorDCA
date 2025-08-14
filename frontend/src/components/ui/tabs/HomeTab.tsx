"use client";

/**
 * HomeTab component displays the main landing content for the mini app.
 * 
 * This is the default tab that users see when they first open the mini app.
 * It provides a simple welcome message and placeholder content that can be
 * customized for specific use cases.
 * 
 * @example
 * ```tsx
 * <HomeTab />
 * ```
 */
import React, { useState, useEffect, useContext, createContext } from 'react';
import { ethers } from 'ethers';

// Context for Web3 and App State
const Web3Context = createContext();

// Web3 Provider Component
const Web3Provider = ({ children }) => {
  const [account, setAccount] = useState('');
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [contract, setContract] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  const CONTRACT_ADDRESS = process.env.REACT_APP_CONTRACT_ADDRESS || '0x...';
  const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

  const CONTRACT_ABI = [
    "function createDCAplan(bytes32 configHash, bool bitmorEnabled, bytes signature)",
    "function makePayment(uint128 usdcAmount, uint128 btcAmount, bool usesPrepaid, bytes32 nonce, bytes signature)",
    "function users(address) view returns (tuple(uint128 totalPaid, uint128 btcAccumulated, uint64 startTime, uint64 lastPaymentTime, uint32 streak, uint32 prepaidDays, uint8 status, bool bitmorEnabled, bool thresholdReached))",
    "function earlyWithdraw(uint128 penaltyAmount, bytes32 nonce, bytes signature)",
    "function completePlan(bytes32 nonce, bytes signature)"
  ];

  const connectWallet = async () => {
    try {
      if (window.ethereum) {
        const web3Provider = new ethers.BrowserProvider(window.ethereum);
        const accounts = await window.ethereum.request({
          method: 'eth_requestAccounts'
        });
        
        const web3Signer = await web3Provider.getSigner();
        const contractInstance = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, web3Signer);
        
        setProvider(web3Provider);
        setSigner(web3Signer);
        setContract(contractInstance);
        setAccount(accounts[0]);
        setIsConnected(true);
      } else {
        alert('Please install MetaMask');
      }
    } catch (error) {
      console.error('Error connecting wallet:', error);
    }
  };

  const apiCall = async (endpoint, method = 'GET', body = null) => {
    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body && { body: JSON.stringify(body) })
      };

      const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'API call failed');
      }
      
      return data.data;
    } catch (error) {
      console.error('API call error:', error);
      throw error;
    }
  };

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length === 0) {
          setIsConnected(false);
          setAccount('');
        } else {
          setAccount(accounts[0]);
        }
      });
    }
  }, []);

  const value = {
    account,
    provider,
    signer,
    contract,
    isConnected,
    connectWallet,
    apiCall
  };

  return (
    <Web3Context.Provider value={value}>
      {children}
    </Web3Context.Provider>
  );
};

// Custom hook to use Web3 context
const useWeb3 = () => {
  const context = useContext(Web3Context);
  if (!context) {
    throw new Error('useWeb3 must be used within Web3Provider');
  }
  return context;
};

// Header Component
const Header = () => {
  const { isConnected, account, connectWallet } = useWeb3();

  return (
    <header className="bg-gradient-to-r from-blue-900 to-purple-900 text-white p-4 shadow-lg">
      <div className="container mx-auto flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center">
            ₿
          </div>
          <h1 className="text-2xl font-bold">BitmorDCA</h1>
        </div>
        
        <div className="flex items-center space-x-4">
          {isConnected ? (
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 bg-green-400 rounded-full"></div>
              <span className="text-sm">
                {account.slice(0, 6)}...{account.slice(-4)}
              </span>
            </div>
          ) : (
            <button
              onClick={connectWallet}
              className="bg-orange-500 hover:bg-orange-600 px-4 py-2 rounded-lg font-medium transition-colors"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

// Plan Creation Component
const PlanCreator = ({ onPlanCreated }) => {
  const { account, contract, apiCall } = useWeb3();
  const [formData, setFormData] = useState({
    targetBTC: '0.1',
    timePeriodDays: '30',
    withdrawalDelayDays: '7',
    penaltyMin: '100', // 1% default
    penaltyMax: '500', // 5% default
    penaltyExponent: '150', // k = 1.5 default
    cadence: 'DAILY',
    bitmorIntegration: false,
    sweepDustThreshold: '10' // $10 default
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [currentBtcPrice, setCurrentBtcPrice] = useState(null);
  const [calculatedDailyAmount, setCalculatedDailyAmount] = useState(null);
  
  // Fetch current BTC price when component mounts
  useEffect(() => {
    const fetchBtcPrice = async () => {
      try {
        const healthData = await apiCall('/health');
        setCurrentBtcPrice(parseFloat(healthData.btcPrice));
      } catch (error) {
        console.error('Error fetching BTC price:', error);
      }
    };
    
    fetchBtcPrice();
  }, [apiCall]);
  
  // Calculate daily amount whenever target BTC, time period, or BTC price changes
  useEffect(() => {
    if (currentBtcPrice && formData.targetBTC && formData.timePeriodDays) {
      const targetBtc = parseFloat(formData.targetBTC);
      const timePeriod = parseInt(formData.timePeriodDays);
      const cadenceFactor = formData.cadence === 'WEEKLY' ? 7 : 1;
      
      // Calculate required amount based on current price
      const totalUsdNeeded = targetBtc * currentBtcPrice;
      const periodsCount = timePeriod / cadenceFactor;
      const amountPerPeriod = totalUsdNeeded / periodsCount;
      
      setCalculatedDailyAmount(amountPerPeriod.toFixed(2));
    }
  }, [currentBtcPrice, formData.targetBTC, formData.timePeriodDays, formData.cadence]);
  

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!account) {
      alert('Please connect your wallet');
      return;
    }

    setLoading(true);
    try {
      // Call backend to create plan configuration
      const planData = await apiCall('/plans/create', 'POST', {
        userAddress: account,
        targetBTC: parseFloat(formData.targetBTC),
        timePeriodDays: parseInt(formData.timePeriodDays),
        withdrawalDelayDays: parseInt(formData.withdrawalDelayDays),
        penaltyMin: parseInt(formData.penaltyMin),
        penaltyMax: parseInt(formData.penaltyMax),
        penaltyExponent: parseInt(formData.penaltyExponent),
        cadence: formData.cadence,
        bitmorIntegration: formData.bitmorIntegration
      });

      // Execute contract transaction
      const tx = await contract.createDCAplan(
        planData.configHash,
        formData.bitmorIntegration,
        planData.signature
      );

      await tx.wait();
      setSuccess(true);
      setError(null);
      if (onPlanCreated) {
        onPlanCreated();
      }
    } catch (error) {
      console.error('Error creating plan:', error);
      setError(error.message || 'An error occurred while creating the plan');
      setSuccess(false);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-2 text-gray-800">DCA Planner</h2>
      <p className="text-gray-600 mb-6">Set your BTC goal and commitment level to start your DCA journey</p>
      
      {currentBtcPrice && (
        <div className="bg-blue-50 p-4 rounded-lg mb-6">
          <p className="text-sm text-blue-800">Current BTC Price: <span className="font-bold">${currentBtcPrice.toLocaleString()}</span></p>
        </div>
      )}
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* BTC Goal Section */}
        <div className="border-b pb-4">
          <h3 className="text-lg font-semibold mb-3 text-gray-700">Your BTC Goal</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Target BTC Amount
              </label>
              <input
                type="number"
                name="targetBTC"
                value={formData.targetBTC}
                onChange={handleInputChange}
                step="0.001"
                min="0.001"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Time Period (Days)
              </label>
              <input
                type="number"
                name="timePeriodDays"
                value={formData.timePeriodDays}
                onChange={handleInputChange}
                min="1"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                DCA Cadence
              </label>
              <select
                name="cadence"
                value={formData.cadence}
                onChange={handleInputChange}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
              </select>
            </div>
            
            {calculatedDailyAmount && (
              <div className="bg-green-50 p-3 rounded-lg flex items-center">
                <div className="w-full">
                  <p className="text-sm text-green-800 font-medium">
                    {formData.cadence === 'DAILY' ? 'Daily' : 'Weekly'} Amount: <span className="font-bold">${calculatedDailyAmount}</span>
                  </p>
                  <p className="text-xs text-green-600 mt-1">
                    This amount is indicative and based on the current BTC price. Actual amounts may vary as BTC price changes.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        
        {/* Commitment Level Section */}
        <div className="border-b pb-4">
          <h3 className="text-lg font-semibold mb-3 text-gray-700">Your Commitment Level</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Withdrawal Delay (Days)
              </label>
              <select
                name="withdrawalDelayDays"
                value={formData.withdrawalDelayDays}
                onChange={handleInputChange}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Minimum delay is 7 days</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Min Penalty (%)
              </label>
              <input
                type="number"
                name="penaltyMin"
                value={formData.penaltyMin}
                onChange={handleInputChange}
                min="100"
                max="500"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Default: 1% (100 basis points)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Penalty (%)
              </label>
              <input
                type="number"
                name="penaltyMax"
                value={formData.penaltyMax}
                onChange={handleInputChange}
                min="100"
                max="500"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <p className="text-xs text-gray-500 mt-1">Default: 5% (500 basis points)</p>
            </div>
            
            <div className="md:col-span-2 bg-yellow-50 p-3 rounded-lg">
              <p className="text-sm text-yellow-800">
                <span className="font-bold">Penalty Calculation:</span> The penalty for early withdrawal decreases over time using the formula:
              </p>
              <p className="text-xs text-yellow-700 mt-1 font-mono">
                penalty_pct = p_min + (p_max − p_min) * (time_remaining / total_time)^1.5
              </p>
              <p className="text-xs text-yellow-600 mt-1">
                Higher penalties show stronger commitment and increase your rewards eligibility.
              </p>
            </div>
          </div>
        </div>
        
        {/* Additional Features Section */}
        <div className="border-b pb-4">
          <h3 className="text-lg font-semibold mb-3 text-gray-700">Additional Features</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="bitmorIntegration"
                name="bitmorIntegration"
                checked={formData.bitmorIntegration}
                onChange={handleInputChange}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="bitmorIntegration" className="text-sm text-gray-700">
                Enable Bitmor Integration
              </label>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sweep Dust Threshold ($)
              </label>
              <input
                type="number"
                name="sweepDustThreshold"
                value={formData.sweepDustThreshold}
                onChange={handleInputChange}
                min="1"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-xs text-gray-500 mt-1">Automatically convert small balances below this value to BTC</p>
            </div>
          </div>
        </div>
        
        <div className="flex justify-center mt-6">
          <button
            type="submit"
            disabled={loading}
            className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 px-8 rounded-lg shadow-lg transform transition-all duration-300 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          >
            {loading ? (
              <div className="flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Creating Plan...
              </div>
            ) : (
              'Create DCA Plan'
            )}
          </button>
        </div>
      </form>
      
      {/* Success Message */}
      {success && (
        <div className="mt-6 bg-green-100 border-l-4 border-green-500 text-green-700 p-4 rounded">
          <p className="font-bold">Success!</p>
          <p>Your DCA plan has been created successfully. You can now start making payments to accumulate BTC.</p>
        </div>
      )}
      
      {/* Error Message */}
      {error && (
        <div className="mt-6 bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded">
          <p className="font-bold">Error</p>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
};

// Main HomeTab Component
export function HomeTab() {
  return (
    <Web3Provider>
      <div className="container mx-auto px-4 py-8">
        <Header />
        <div className="mt-8">
          <PlanCreator />
        </div>
      </div>
    </Web3Provider>
  );
};

          