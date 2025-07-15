// Firebase Configuration
// Replace these values with your actual Firebase project configuration
export const firebaseConfig = {
  apiKey: "AIzaSyDiRGvkQbnLlpnJT3fEEQrY1A3nwLVIFY0",
  authDomain: "queue-joy-aa21b.firebaseapp.com",
  databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "queue-joy-aa21b",
  storageBucket: "queue-joy-aa21b.appspot.com",
  messagingSenderId: "950240394209",
  appId: "1:950240394209:web:78d4f2471d2d89ac91f0a0"
};


// Firebase Database Structure
/*
/settings/
  counters/
    counter1/
      name: "Counter 1"
      prefix: "A"
      nowServing: 102
      lastIssued: 105
      active: true
    counter2/
      name: "Counter 2"
      prefix: "B"
      nowServing: 50
      lastIssued: 53
      active: true
  adImage: "data:image/png;base64,..." or "https://example.com/ad.png"

/queues/
  2024-01-15/
    counter1/
      A102/
        status: "waiting"
        timestamp: 1705123456789
      A103/
        status: "called"
        timestamp: 1705123556789

/analytics/
  2024-01-15/
    counter1/
      A102/
        waitTimeMinutes: 15
        timestampCalled: 1705123556789
*/