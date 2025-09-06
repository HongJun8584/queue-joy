// Import Firebase dependencies
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getMessaging, getToken } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js';
import { getDatabase, ref, set } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDiRGvkQbnLlpnJT3fEEQrY1A3nwLVIFY0",
    authDomain: "queue-joy-aa21b.firebaseapp.com",
    databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "queue-joy-aa21b",
    storageBucket: "queue-joy-aa21b.firebasestorage.app",
    messagingSenderId: "950240394209",
    appId: "1:950240394209:web:78d4f2471d2d89ac91f0a0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);
const database = getDatabase(app);

// Register service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/firebase-messaging-sw.js')
        .then(registration => {
            console.log('Service Worker registered:', registration);
            // Request FCM token after service worker registration
            requestFcmToken();
        })
        .catch(error => {
            console.error('Service Worker registration failed:', error);
        });
}

// Request FCM token and store in database
async function requestFcmToken() {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('Notification permission granted.');
            const vapidKey = 'BM6-cvmqAerBUtL2It-9OZKdJZqRtpltM75S03sig8mg8MankP5UOEvSm0m1zUbXb6azFI6mkJZylT7EXjXeIBc';
            const token = await getToken(messaging, { vapidKey });
            if (token) {
                console.log('FCM Token:', token);
                // Get queueId from localStorage
                const queueDataStr = localStorage.getItem('queueData');
                if (queueDataStr) {
                    const queueData = JSON.parse(queueDataStr);
                    const queueId = queueData.queueId;
                    if (queueId) {
                        // Store token in Firebase Realtime Database
                        await set(ref(database, `/tokens/${queueId}`), token);
                        console.log(`FCM token stored for queueId: ${queueId}`);
                    }
                }
            } else {
                console.log('No registration token available.');
            }
        } else {
            console.log('Notification permission denied.');
        }
    } catch (error) {
        console.error('Error requesting FCM token:', error);
    }
}