import React, { useState, useEffect, useMemo, useId } from 'react';
import * as XLSX from 'xlsx';
import { showToast } from '../toastContext.jsx';
import Modal from '../ui/Modal.jsx';
import Confirm from '../ui/Confirm.jsx';
import { BUSINESSES, MENU_UNITS } from '../constants.js';
import { fmt$, uniqSuggestions, safePrice } from '../formatters.js';
import { load, save, uid, today } from '../utils/storage.js';
import { logActivity } from '../utils/activity.js';

function FI({ label, suggestions, fieldStyle, ...props }) {
  const listId = useId();
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const baseFieldStyle = label ? {} : { marginBottom: 0 };
  return (
    <div className="field" style={{ ...baseFieldStyle, ...fieldStyle }}>
      {label&&<label>{label}</label>}
      <input className="input" {...props} list={hasSuggestions ? listId : undefined} />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}
function Btn({ className='', children, ...p }) {
  return <button className={`btn ${className}`} {...p}>{children}</button>;
}

export default function MenuMarginsLab({ items, priceHistory, selectedBusiness }) {
  const [menuItems, setMenuItems] = useState(() => load('_menuItems', []));
  const [recipes, setRecipes] = useState(() => load('_menuRecipes', []));
  const [search, setSearch] = useState('');
  const [menuTypeF, setMenuTypeF] = useState('all');
  const [bizF, setBizF] = useState(selectedBusiness || 'all');
  const [asOfDate, setAsOfDate] = useState(today());
  const [targetMargin, setTargetMargin] = useState(32);
  const [showMenuForm, setShowMenuForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState('');
  const [pendingDeleteMenuId, setPendingDeleteMenuId] = useState(null);
  const [menuForm, setMenuForm] = useState(() => ({
    name:'',
    menuType:'regular',
    category:'Main',
    defaultUnit:'each',
    basePrice:'',
    pricing:{ degrill:'', parathas:'', dera:'' },
    notes:'',
    active:true
  }));

  useEffect(() => { save('_menuItems', menuItems); }, [menuItems]);
  useEffect(() => { save('_menuRecipes', recipes); }, [recipes]);

  const toBase = (qty, unit) => {
    const q = Number(qty || 0);
    const u = String(unit || 'each').toLowerCase();
    const mult = ({ each:1, oz:1, lb:16, g:0.035274, kg:35.274, ml:0.033814, l:33.814 })[u] || 1;
    return q * mult;
  };
  const itemLatestCost = (itemId) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return null;
    const sellerPrices = (item.sellers || []).map(s => safePrice(s.price)).filter(v => v !== null);
    if (!sellerPrices.length) return null;
    return Math.min(...sellerPrices);
  };
  const itemCostAtDate = (itemId, dateStr) => {
    const hist = priceHistory
      .filter(h => h.itemId === itemId && h.date <= dateStr)
      .sort((a,b) => b.date.localeCompare(a.date));
    if (hist.length) return Number(hist[0].newPrice || 0);
    return itemLatestCost(itemId);
  };
  const recipeFor = (menuItemId) => {
    const list = recipes.filter(r => r.menuItemId === menuItemId);
    if (!list.length) return null;
    return [...list].sort((a,b) => String(b.effectiveDate || '').localeCompare(String(a.effectiveDate || '')))[0];
  };
  const calcMenuMetrics = (m) => {
    const recipe = recipeFor(m.id);
    const lines = (recipe?.lines || []).map(line => {
      const invItem = items.find(i => i.id === line.itemId);
      const unitCostNow = itemLatestCost(line.itemId);
      const unitCostAtDate = itemCostAtDate(line.itemId, asOfDate);
      const qtyBase = toBase(line.qty, line.unit);
      const invBase = toBase(1, invItem?.unit || 'each');
      const scale = invBase ? (qtyBase / invBase) : 0;
      const wasteMult = 1 + (Number(line.wastePct || 0) / 100);
      return {
        ...line,
        itemName: invItem?.name || 'Unknown Item',
        unitCostNow,
        unitCostAtDate,
        lineCostNow: (unitCostNow ?? 0) * scale * wasteMult,
        lineCostAtDate: (unitCostAtDate ?? 0) * scale * wasteMult
      };
    });
    const costNow = lines.reduce((s,l)=>s+(l.lineCostNow||0),0);
    const costAtDate = lines.reduce((s,l)=>s+(l.lineCostAtDate||0),0);
    const price = Number(m.pricing?.[bizF === 'all' ? selectedBusiness : bizF] || m.basePrice || 0);
    const profitNow = price - costNow;
    const marginNow = price > 0 ? (profitNow / price * 100) : 0;
    const profitThen = price - costAtDate;
    const marginThen = price > 0 ? (profitThen / price * 100) : 0;
    const recommended = costNow > 0 ? (costNow / (1 - (targetMargin/100))) : price;
    return { price, costNow, costAtDate, profitNow, marginNow, profitThen, marginThen, recommended, lines, recipe };
  };

  const menuCategorySuggestions = useMemo(()=>uniqSuggestions(...menuItems.map(m=>m.category)),[menuItems]);
  const menuNameSuggestions = useMemo(()=>uniqSuggestions(...menuItems.map(m=>m.name)),[menuItems]);

  const filteredMenus = useMemo(() => menuItems.filter(m => {
    if (menuTypeF !== 'all' && m.menuType !== menuTypeF) return false;
    if (bizF !== 'all' && !(m.pricing && m.pricing[bizF] !== undefined)) return false;
    const q = search.toLowerCase().trim();
    if (q && !(`${m.name} ${m.category} ${m.notes || ''}`.toLowerCase().includes(q))) return false;
    return true;
  }), [menuItems, menuTypeF, bizF, search]);

  const rows = useMemo(() => filteredMenus.map(m => ({ menu:m, metrics:calcMenuMetrics(m) })), [filteredMenus, recipes, items, priceHistory, asOfDate, targetMargin, bizF, selectedBusiness]);
  const lowMarginRows = rows.filter(r => r.metrics.marginNow < Number(targetMargin || 0));
  const missingRecipeRows = rows.filter(r => !r.metrics.recipe);
  const missingCostRows = rows.filter(r => r.metrics.lines.some(l => l.unitCostNow === null || l.unitCostAtDate === null));

  function resetMenuForm() {
    setMenuForm({ name:'', menuType:'regular', category:'Main', defaultUnit:'each', basePrice:'', pricing:{degrill:'',parathas:'',dera:''}, notes:'', active:true });
    setEditingId(null);
  }
  function openEditMenu(m) {
    setEditingId(m.id);
    setMenuForm({
      name:m.name || '',
      menuType:m.menuType || 'regular',
      category:m.category || 'Main',
      defaultUnit:m.defaultUnit || 'each',
      basePrice:String(m.basePrice ?? ''),
      pricing:{
        degrill:String(m.pricing?.degrill ?? ''),
        parathas:String(m.pricing?.parathas ?? ''),
        dera:String(m.pricing?.dera ?? '')
      },
      notes:m.notes || '',
      active:m.active !== false
    });
    setShowMenuForm(true);
  }
  function saveMenuItem() {
    if (!menuForm.name.trim()) { showToast('Menu item name is required. [DMG-E006]', 'error'); return; }
    const payload = {
      id: editingId || uid(),
      name: menuForm.name.trim(),
      menuType: menuForm.menuType,
      category: menuForm.category.trim() || 'Main',
      defaultUnit: menuForm.defaultUnit || 'each',
      basePrice: Number(menuForm.basePrice || 0),
      pricing: {
        degrill: Number(menuForm.pricing.degrill || 0),
        parathas: Number(menuForm.pricing.parathas || 0),
        dera: Number(menuForm.pricing.dera || 0)
      },
      notes: menuForm.notes || '',
      active: !!menuForm.active,
      updatedAt: new Date().toISOString()
    };
    if (editingId) {
      setMenuItems(prev => prev.map(x => x.id === editingId ? payload : x));
      logActivity('update_menu_item', payload.name);
    } else {
      setMenuItems(prev => [...prev, payload]);
      logActivity('create_menu_item', payload.name);
    }
    showToast('Menu item saved.');
    setShowMenuForm(false);
    resetMenuForm();
  }
  function deleteMenuItem(menuId) {
    setPendingDeleteMenuId(menuId);
  }
  function confirmDeleteMenuItem() {
    const menuId = pendingDeleteMenuId;
    if (!menuId) return;
    setPendingDeleteMenuId(null);
    setMenuItems(prev => prev.filter(x => x.id !== menuId));
    setRecipes(prev => prev.filter(x => x.menuItemId !== menuId));
    showToast('Menu item deleted.');
  }
  function addRecipeVersion(menuId) {
    const base = {
      id: uid(),
      menuItemId: menuId,
      version: `v${recipes.filter(r => r.menuItemId===menuId).length + 1}`,
      effectiveDate: today(),
      notes: '',
      lines: [{ id:uid(), itemId:'', qty:'', unit:'each', wastePct:'' }]
    };
    setRecipes(prev => [...prev, base]);
    showToast('Recipe version added.');
  }
  function updateRecipe(recipeId, updater) {
    setRecipes(prev => prev.map(r => r.id === recipeId ? updater(r) : r));
  }
  function exportCsv() {
    if (!menuItems.length) { showToast('No menu items to export.', 'error'); return; }
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Name', 'Category', 'Type', 'Unit', 'Base Price', 'Price (DeGrill)', 'Price (Parathas)', 'Price (Dera)', 'Notes'];
    const csvRows = menuItems.map(item => [
      item.name || '',
      item.category || '',
      item.menuType || '',
      item.defaultUnit || 'each',
      item.basePrice != null ? +Number(item.basePrice).toFixed(2) : '',
      item.pricing?.degrill != null ? +Number(item.pricing.degrill).toFixed(2) : '',
      item.pricing?.parathas != null ? +Number(item.pricing.parathas).toFixed(2) : '',
      item.pricing?.dera != null ? +Number(item.pricing.dera).toFixed(2) : '',
      item.notes || '',
    ]);
    const csv = [header.map(esc).join(','), ...csvRows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'menu-items-' + today() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Menu items exported.');
  }
  function exportMarginsCsv() {
    const header = ['Menu Item','Type','Store','Price','Current Cost','Current Margin %','AsOf Cost','AsOf Margin %','Recommended Price','Low Margin'];
    const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = rows.map(r => {
      const store = bizF === 'all' ? selectedBusiness : bizF;
      return [
        r.menu.name,
        r.menu.menuType,
        store,
        r.metrics.price.toFixed(2),
        r.metrics.costNow.toFixed(2),
        r.metrics.marginNow.toFixed(2),
        r.metrics.costAtDate.toFixed(2),
        r.metrics.marginThen.toFixed(2),
        r.metrics.recommended.toFixed(2),
        r.metrics.marginNow < Number(targetMargin||0) ? 'YES' : 'NO'
      ].map(esc).join(',');
    });
    const csv = [header.map(esc).join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `menu-margins-${today()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Margin report exported.');
  }
  function exportMenuExcel() {
    if (!menuItems.length) { showToast('No menu items to export.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const itemHeader = ['Name', 'Category', 'Type', 'Unit', 'Base Price', 'Price (DeGrill)', 'Price (Parathas)', 'Price (Dera)', 'Notes'];
    const itemRows = menuItems.map(item => [
      item.name || '', item.category || '', item.menuType || '', item.defaultUnit || 'each',
      item.basePrice != null ? +Number(item.basePrice).toFixed(2) : '',
      item.pricing?.degrill != null ? +Number(item.pricing.degrill).toFixed(2) : '',
      item.pricing?.parathas != null ? +Number(item.pricing.parathas).toFixed(2) : '',
      item.pricing?.dera != null ? +Number(item.pricing.dera).toFixed(2) : '',
      item.notes || '',
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([itemHeader, ...itemRows]), 'Menu Items');
    if (rows.length) {
      const store = bizF === 'all' ? selectedBusiness : bizF;
      const mHeader = ['Menu Item','Type','Store','Price','Current Cost','Current Margin %','Recommended Price','Low Margin'];
      const mRows = rows.map(r => [
        r.menu.name, r.menu.menuType, store,
        +Number(r.metrics.price).toFixed(2), +Number(r.metrics.costNow).toFixed(2),
        +Number(r.metrics.marginNow).toFixed(2), +Number(r.metrics.recommended).toFixed(2),
        r.metrics.marginNow < Number(targetMargin||0) ? 'YES' : 'NO'
      ]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([mHeader, ...mRows]), 'Margins');
    }
    XLSX.writeFile(wb, 'menu-items-' + today() + '.xlsx');
    showToast('Menu items exported as Excel.');
  }

  function applyRecommendedPrice(menu, metrics) {
    const store = bizF === 'all' ? selectedBusiness : bizF;
    const rounded = +Number(metrics.recommended || 0).toFixed(2);
    setMenuItems(prev => prev.map(m => {
      if (m.id !== menu.id) return m;
      return {
        ...m,
        pricing: { ...(m.pricing || {}), [store]: rounded },
        updatedAt: new Date().toISOString()
      };
    }));
    showToast(`Set ${menu.name} price to ${fmt$(rounded)} for ${BUSINESSES[store]?.name || store}.`);
    logActivity('apply_target_price', `${menu.name} -> ${store} ${rounded}`);
  }
  const topCostDrivers = (metrics) => {
    return [...(metrics.lines || [])]
      .sort((a,b) => (b.lineCostNow || 0) - (a.lineCostNow || 0))
      .slice(0, 3);
  };

  return (
    <div>
      <div className="flex-between mb-3 flex-wrap gap-2">
        <div className="section-title" style={{margin:0}}>Menu Costing & Margin Analytics</div>
        <div className="flex gap-2">
          <Btn className="btn-outline btn-sm" onClick={exportMarginsCsv}>⬇ Margin CSV</Btn>
          <Btn className="btn-outline btn-sm" onClick={exportCsv}>⬇ CSV</Btn>
          <Btn className="btn-outline btn-sm" onClick={exportMenuExcel}>⬇ Excel</Btn>
          <Btn className="btn-primary btn-sm" onClick={()=>{resetMenuForm();setShowMenuForm(true);}}>+ Add Menu Item</Btn>
        </div>
      </div>
      <div style={{background:'#E8F4FC',border:'1px solid #B6DBF7',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12.5,color:'#1e4f72'}}>
        Define recipes once, keep grocery prices updated, and this module auto-calculates current and historical margins by menu item and store.
      </div>

      <div className="card mb-4">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))',gap:10}}>
          <div className="field" style={{margin:0}}><label>Search</label><input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Menu item/category" /></div>
          <div className="field" style={{margin:0}}><label>Menu Type</label><select className="input" value={menuTypeF} onChange={e=>setMenuTypeF(e.target.value)}><option value="all">All</option><option value="regular">Regular</option><option value="catering">Catering</option></select></div>
          <div className="field" style={{margin:0}}><label>Store</label><select className="input" value={bizF} onChange={e=>setBizF(e.target.value)}><option value="all">Current Store</option>{Object.keys(BUSINESSES).map(k=><option key={k} value={k}>{BUSINESSES[k].name}</option>)}</select></div>
          <div className="field" style={{margin:0}}><label>Cost As-Of Date</label><input className="input" type="date" value={asOfDate} onChange={e=>setAsOfDate(e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>Target Margin %</label><input className="input" type="number" min="0" max="95" step="0.5" value={targetMargin} onChange={e=>setTargetMargin(e.target.value)} /></div>
        </div>
        <div style={{marginTop:10,fontSize:13,color:'#666'}}>
          Total Items: <strong>{rows.length}</strong>
          {' · '}Below Target: <strong style={{color:lowMarginRows.length?'#991b1b':'#166534'}}>{lowMarginRows.length}</strong>
          {' · '}Missing Recipe: <strong style={{color:missingRecipeRows.length?'#991b1b':'#166534'}}>{missingRecipeRows.length}</strong>
          {' · '}Missing Cost Data: <strong style={{color:missingCostRows.length?'#991b1b':'#166534'}}>{missingCostRows.length}</strong>
        </div>
      </div>

      <div className="card mb-4" style={{padding:0}}>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Item</th><th>Type</th><th>Store Price</th><th>Current Cost</th><th>Current Margin</th><th>As-Of Margin</th><th>Recommended Price</th><th>Recipe</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map(({menu,metrics})=>(
                <React.Fragment key={menu.id}>
                <tr>
                  <td><div style={{fontWeight:700}}>{menu.name}</div><div style={{fontSize:11,color:'#777'}}>{menu.category}</div></td>
                  <td>{menu.menuType}</td>
                  <td>{fmt$(metrics.price)}</td>
                  <td>{fmt$(metrics.costNow)}</td>
                  <td style={{fontWeight:700,color:metrics.marginNow<0?'#991b1b':metrics.marginNow<targetMargin?'#b45309':'#166534'}}>
                    {metrics.marginNow.toFixed(1)}%
                    {metrics.marginNow < 0 && <span className="badge badge-user" style={{marginLeft:6,background:'#fee2e2',color:'#991b1b'}}>NEG</span>}
                    {metrics.marginNow >= 0 && metrics.marginNow < targetMargin && <span className="badge badge-user" style={{marginLeft:6,background:'#fff7ed',color:'#b45309'}}>LOW</span>}
                  </td>
                  <td>{metrics.marginThen.toFixed(1)}%</td>
                  <td>{fmt$(metrics.recommended)}</td>
                  <td>{metrics.recipe ? `${metrics.recipe.version} (${metrics.lines.length} lines)` : <span style={{color:'#991b1b'}}>Missing</span>}</td>
                  <td style={{whiteSpace:'nowrap'}}>
                    <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>setExpandedId(v=>v===menu.id?'':menu.id)}>{expandedId===menu.id?'Hide':'Details'}</Btn>
                    <Btn className="btn-success btn-sm" style={{marginRight:4}} onClick={()=>applyRecommendedPrice(menu, metrics)}>Set Target</Btn>
                    <Btn className="btn-secondary btn-sm" style={{marginRight:4}} onClick={()=>openEditMenu(menu)}>Edit</Btn>
                    <Btn className="btn-outline btn-sm" style={{marginRight:4}} onClick={()=>addRecipeVersion(menu.id)}>+ Recipe</Btn>
                    <Btn className="btn-danger btn-sm" onClick={()=>deleteMenuItem(menu.id)}>Del</Btn>
                  </td>
                </tr>
                {expandedId===menu.id && (
                  <tr>
                    <td colSpan={9} style={{background:'#fffdf8'}}>
                      <div style={{padding:'10px 8px'}}>
                        <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6}}>Top Cost Drivers</div>
                        {topCostDrivers(metrics).length ? (
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:8}}>
                            {topCostDrivers(metrics).map((d, i) => (
                              <div key={`${menu.id}-drv-${i}`} style={{border:'1px solid #EED9B0',borderRadius:6,padding:'8px 10px',fontSize:12.5}}>
                                <div style={{fontWeight:700}}>{d.itemName}</div>
                                <div>Current Cost: <strong>{fmt$(d.lineCostNow || 0)}</strong></div>
                                <div>As-Of Cost: <strong>{fmt$(d.lineCostAtDate || 0)}</strong></div>
                              </div>
                            ))}
                          </div>
                        ) : <div style={{fontSize:12.5,color:'#777'}}>No recipe lines yet.</div>}
                        {metrics.lines.some(l => l.unitCostNow === null || l.unitCostAtDate === null) && (
                          <div style={{marginTop:8,background:'#fff7ed',border:'1px solid #fdba74',borderRadius:6,padding:'8px 10px',fontSize:12.5,color:'#9a3412'}}>
                            Missing ingredient cost data detected for one or more lines. Add supplier prices in Item Database / Price Updater for accurate margins.
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
              {!rows.length && <tr><td colSpan={9}><div className="empty-state">No menu items yet. Add one to begin costing.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {menuItems.map(m => {
        const rs = recipes.filter(r => r.menuItemId === m.id).sort((a,b)=>String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
        if (!rs.length) return null;
        return (
          <div className="card mb-3" key={`r-${m.id}`}>
            <div style={{fontWeight:700,color:'var(--brown)',marginBottom:8}}>Recipe Versions — {m.name}</div>
            {rs.map(r => (
              <div key={r.id} style={{border:'1px solid #EED9B0',borderRadius:8,padding:10,marginBottom:8}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 160px 160px',gap:8,marginBottom:8}}>
                  <FI label="Version" value={r.version} onChange={e=>updateRecipe(r.id, old=>({ ...old, version:e.target.value }))} />
                  <FI label="Effective Date" type="date" value={r.effectiveDate} onChange={e=>updateRecipe(r.id, old=>({ ...old, effectiveDate:e.target.value }))} />
                  <FI label="Notes" value={r.notes || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, notes:e.target.value }))} />
                </div>
                {(r.lines || []).map((ln, idx) => (
                  <div key={ln.id || idx} style={{display:'grid',gridTemplateColumns:'2fr 120px 120px 120px auto',gap:8,alignItems:'end',marginBottom:6}}>
                    <div className="field" style={{margin:0}}>
                      <label>Ingredient</label>
                      <select className="input" value={ln.itemId || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,itemId:e.target.value}:x) }))}>
                        <option value="">Choose item</option>
                        {items.map(it=><option key={it.id} value={it.id}>{it.name} ({it.unit})</option>)}
                      </select>
                    </div>
                    <FI label="Qty" type="number" min="0" step="0.001" value={ln.qty || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,qty:e.target.value}:x) }))} />
                    <div className="field" style={{margin:0}}>
                      <label>Unit</label>
                      <select className="input" value={ln.unit || 'each'} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,unit:e.target.value}:x) }))}>
                        {MENU_UNITS.map(u=><option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <FI label="Waste %" type="number" min="0" step="0.1" value={ln.wastePct || ''} onChange={e=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.map((x,i)=>i===idx?{...x,wastePct:e.target.value}:x) }))} />
                    <Btn className="btn-danger btn-sm" onClick={()=>updateRecipe(r.id, old=>({ ...old, lines: old.lines.filter((_,i)=>i!==idx) }))}>✕</Btn>
                  </div>
                ))}
                <Btn className="btn-outline btn-sm" onClick={()=>updateRecipe(r.id, old=>({ ...old, lines:[...(old.lines||[]),{id:uid(),itemId:'',qty:'',unit:'each',wastePct:''}] }))}>+ Ingredient Line</Btn>
              </div>
            ))}
          </div>
        );
      })}

      <Modal open={showMenuForm} onClose={()=>setShowMenuForm(false)} title={editingId?'Edit Menu Item':'Add Menu Item'} maxW={760}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <FI label="Item Name" value={menuForm.name} onChange={e=>setMenuForm(f=>({ ...f, name:e.target.value }))} suggestions={menuNameSuggestions} />
          <FI label="Category" value={menuForm.category} onChange={e=>setMenuForm(f=>({ ...f, category:e.target.value }))} suggestions={menuCategorySuggestions} />
          <div className="field" style={{margin:0}}><label>Menu Type</label><select className="input" value={menuForm.menuType} onChange={e=>setMenuForm(f=>({ ...f, menuType:e.target.value }))}><option value="regular">Regular</option><option value="catering">Catering</option></select></div>
          <div className="field" style={{margin:0}}><label>Unit</label><select className="input" value={menuForm.defaultUnit} onChange={e=>setMenuForm(f=>({ ...f, defaultUnit:e.target.value }))}>{MENU_UNITS.map(u=><option key={u} value={u}>{u}</option>)}</select></div>
          <FI label="Default Price" type="number" min="0" step="0.01" value={menuForm.basePrice} onChange={e=>setMenuForm(f=>({ ...f, basePrice:e.target.value }))} />
          <FI label="Notes" value={menuForm.notes} onChange={e=>setMenuForm(f=>({ ...f, notes:e.target.value }))} />
        </div>
        <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid #EED9B0'}}>
          <div style={{fontWeight:700,color:'var(--brown)',marginBottom:6,fontSize:13}}>Store Pricing Overrides</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10}}>
            <FI label="DeGrill" type="number" min="0" step="0.01" value={menuForm.pricing.degrill} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,degrill:e.target.value} }))} />
            <FI label="Parathas & Platters" type="number" min="0" step="0.01" value={menuForm.pricing.parathas} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,parathas:e.target.value} }))} />
            <FI label="Dera Masala Grill" type="number" min="0" step="0.01" value={menuForm.pricing.dera} onChange={e=>setMenuForm(f=>({ ...f, pricing:{...f.pricing,dera:e.target.value} }))} />
          </div>
        </div>
        <div className="flex gap-2" style={{justifyContent:'flex-end',marginTop:12}}>
          <Btn className="btn-outline" onClick={()=>setShowMenuForm(false)}>Cancel</Btn>
          <Btn className="btn-primary" onClick={saveMenuItem}>{editingId?'Save Changes':'Add Item'}</Btn>
        </div>
      </Modal>
      <Confirm
        open={!!pendingDeleteMenuId}
        title="Delete menu item?"
        message="This removes the menu item and every saved recipe version for it on this device."
        detail="Export a backup from Settings first if you might need to recover this data."
        dangerCode="DMG-E012 (local data change)"
        confirmLabel="Delete menu item"
        confirmClass="btn-danger"
        onConfirm={confirmDeleteMenuItem}
        onCancel={() => setPendingDeleteMenuId(null)}
      />
    </div>
  );
}

