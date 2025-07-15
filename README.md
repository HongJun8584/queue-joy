# Queue Joy - Digital Queue Management System

A modern, mobile-first digital queue management system that replaces traditional paper tickets and LED displays.

## Features

### User Interface
- **Landing Page** (`index.html`): Get queue numbers instantly
- **Status Tracking** (`status.html`): Real-time queue position monitoring
- **Entertainment** (`game.html`): Memory game while waiting
- **Counter Panel** (React app): Staff management interface

### Core Functionality
- Real-time queue synchronization across all devices
- Secure queue number generation and tracking
- Staff-uploaded advertisement display
- Audio notifications when customer's turn arrives
- Mobile-optimized responsive design
- Offline-capable with localStorage backup

## Technical Stack

- **Frontend**: HTML5, Tailwind CSS, Vanilla JavaScript, React (counter panel)
- **Backend**: Firebase Realtime Database
- **Deployment**: Static hosting (Vercel, Netlify, Firebase Hosting)

## Setup Instructions

### 1. Firebase Configuration

1. Create a new Firebase project at [Firebase Console](https://console.firebase.google.com)
2. Enable Realtime Database
3. Copy your Firebase configuration
4. Update `firebase-config.js` with your project details

### 2. Firebase Security Rules

```json
{
  "rules": {
    "settings": {
      ".read": true,
      "counters": {
        ".write": "auth != null"
      },
      "adImage": {
        ".write": "auth != null"
      }
    },
    "queues": {
      ".read": true,
      ".write": true
    },
    "analytics": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

### 3. Deployment

#### Option A: Vercel
1. Connect your GitHub repository to Vercel
2. Set build command: `npm run build`
3. Set output directory: `dist`
4. Deploy

#### Option B: Firebase Hosting
1. Install Firebase CLI: `npm install -g firebase-tools`
2. Login: `firebase login`
3. Initialize: `firebase init hosting`
4. Deploy: `firebase deploy`

#### Option C: Netlify
1. Connect your GitHub repository to Netlify
2. Set build command: `npm run build`
3. Set publish directory: `dist`
4. Deploy

## Usage

### For Customers
1. Scan QR code or visit the website
2. Tap "Get My Number" to join the queue
3. Monitor your position on the status page
4. Play games while waiting
5. Receive notification when it's your turn

### For Staff
1. Access the counter panel (separate React app)
2. Enter PIN to authenticate
3. Set up counters with custom prefixes
4. Call next numbers, skip, or reset counters
5. Upload advertisement images
6. Monitor queue analytics

## File Structure

```
queue-joy/
├── public/
│   ├── index.html          # Customer landing page
│   ├── status.html         # Queue status tracking
│   ├── game.html          # Memory game
│   └── firebase-config.js  # Firebase configuration
├── src/                   # React counter panel
│   ├── components/
│   ├── stores/
│   └── App.tsx
├── package.json
└── README.md
```

## Data Structure

### Firebase Realtime Database
```
/settings/
  counters/
    counter1/
      name: "Counter 1"
      prefix: "A"
      nowServing: 102
      lastIssued: 105
      active: true
  adImage: "base64-encoded-image-data"

/queues/
  YYYY-MM-DD/
    counterId/
      queueId/
        status: "waiting"
        timestamp: SERVER_TIMESTAMP
```

## Security Features

- PIN-based authentication for staff access
- Firebase security rules prevent unauthorized access
- No sensitive data exposed in frontend code
- Session management with localStorage
- Input validation and sanitization

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For support and questions, please open an issue on GitHub or contact the development team.