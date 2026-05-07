import React, { useState, useRef } from 'react';
import { load, save } from '../utils/storage.js';
import { logFailure, syncCredentialsToBackend } from '../authHelpers.js';

function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function FirstRunSetup({ onDone, apiBase }) {
  const [err, setErr] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const importRef = useRef();

  async function importStarter(file) {
    if (!file) return;
    setErr('');
    setImportMsg('');
    try {
      const zip = await JSZip.loadAsync(file);
      const keys = ['items','shoppingList','purchaseInvoices','cateringInvoices','customers','priceHistory','settings','credentials','_profiles','_adminPasswordHash','_userPermissions'];
      let loadedCredentials = false;
      for (const k of keys) {
        const f = zip.file(k + '.json');
        if (!f) continue;
        const v = JSON.parse(await f.async('string'));
        if (k === 'settings' && v && v.selectedBusiness) save('_lastBiz', v.selectedBusiness);
        else save(k, v);
        if (k === 'credentials' && v && typeof v === 'object') loadedCredentials = true;
      }
      if (loadedCredentials) {
        const creds = load('credentials', {});
        const syncResult = await syncCredentialsToBackend(creds, apiBase);
        if (!syncResult.ok) {
          logFailure({ area:'setup', action:'sync_credentials_backend', error:syncResult.error });
        }
        setImportMsg('Starter file imported. You can sign in now.');
        onDone();
      } else {
        setErr('This starter file is missing login accounts. Ask your admin for a valid starter file.');
      }
    } catch (e) {
      setErr('Starter file import failed. Use a valid app backup ZIP.');
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="icon">🍽️</div>
          <h1>Welcome — Starter File Required</h1>
          <p>This app can only be initialized using a starter file from your manager/admin.</p>
        </div>
        <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:14,fontSize:13,color:'#1e4f72'}}>
          <strong>Quick start:</strong> Click <strong>Import Starter File</strong> and choose the ZIP provided by your admin.
        </div>
        <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
          <Btn className="btn-outline" onClick={()=>importRef.current?.click()}>⬆ Import Starter File</Btn>
          <input ref={importRef} type="file" accept=".zip" style={{display:'none'}} onChange={e=>{importStarter(e.target.files[0]);e.target.value='';}} />
        </div>
        {importMsg && <div style={{background:'#dcfce7',color:'#166534',padding:'8px 12px',borderRadius:6,marginBottom:12,fontSize:13}}>{importMsg}</div>}
        <div style={{background:'#FFF8DC',border:'1px solid #DEB887',borderRadius:8,padding:'10px 14px',marginBottom:8,fontSize:13,color:'#7a5c00'}}>
          🔒 Manual setup is disabled. Only approved starter files can unlock access.
        </div>
        {err && <div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:5,marginBottom:12,fontSize:13}}>{err}</div>}
      </div>
    </div>
  );
}
