import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';

const root = document.getElementById('root');
const app = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
// Pre-rendered pages are hydrated; the dev server renders from scratch. (In dev, #root only holds the
// template's placeholder comment, which is a child *node* but not pre-rendered content.)
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
