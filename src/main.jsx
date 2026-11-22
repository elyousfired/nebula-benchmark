import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import SqueezePage from './SqueezePage.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/squeeze' ? <SqueezePage /> : <App />}
  </StrictMode>,
);
