import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
<<<<<<< HEAD
import { CookieConsentProvider } from './contexts/CookieConsentContext';
import CookieBanner from './components/CookieBanner';
import CookiePreferencesModal from './components/CookiePreferencesModal';
=======
>>>>>>> origin/main
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
<<<<<<< HEAD
      <CookieConsentProvider>
        <AuthProvider>
          <SocketProvider>
            <App />
            <CookieBanner />
            <CookiePreferencesModal />
          </SocketProvider>
        </AuthProvider>
      </CookieConsentProvider>
=======
      <AuthProvider>
        <SocketProvider>
          <App />
        </SocketProvider>
      </AuthProvider>
>>>>>>> origin/main
    </BrowserRouter>
  </React.StrictMode>
);
