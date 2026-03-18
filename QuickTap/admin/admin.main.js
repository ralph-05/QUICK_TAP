// Admin Main Logic
console.log("Admin Main JS v4 Loaded - Fix ID Collision")

let db
let adminLogsUnsub = null
let cashierMonitorUnsub = null

// Declare getDB function or import it
function getDB() {
  return window.db
}

async function safeUpdateRowAdmin(table, match, payload) {
  let currentPayload = { ...payload }
  const tryUpdate = async () => {
    let query = db.from(table).update(currentPayload)
    Object.entries(match || {}).forEach(([key, value]) => {
      query = query.eq(key, value)
    })
    return await query
  }
  let { error } = await tryUpdate()
  let attempts = 0
  while (error && attempts < 6) {
    const msg = String(error.message || "")
    let removed = false
    for (const col of Object.keys(currentPayload)) {
      const colHit = msg.includes(`'${col}'`) || msg.includes(`\"${col}\"`) || msg.includes(` ${col} `)
      const missing = msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("Could not find")
      if (colHit && missing) {
        delete currentPayload[col]
        removed = true
        break
      }
    }
    if (!removed || Object.keys(currentPayload).length === 0) break
    ;({ error } = await tryUpdate())
    attempts++
  }
  if (error) throw error
  return true
}

// Initialize Supabase reference when database is ready
function initializeAdmin() {
  db = getDB()
  if (!db) {
    console.error('[v0] Database not available');
    setTimeout(initializeAdmin, 100);
    return;
  }
  
  console.log('[v0] Admin initialized');
  loadMenu()
  loadSizesDatalist()
  cleanupArchivedStaff()
  if (typeof window.loadPromos === 'function') {
    window.loadPromos()
  }
  if (typeof window.initCalendar === 'function') {
    window.initCalendar()
  }
  
  subscribeToBookings()
  subscribeToAdminLogsRealtime()
  subscribeToCashierMonitoringRealtime()
}

async function cleanupArchivedStaff() {
  try {
    const cutoff = new Date()
    cutoff.setFullYear(cutoff.getFullYear() - 1)
    await db.from('staff').delete().eq('archived', true).lt('archived_at', cutoff.toISOString())
  } catch (e) {
    // Ignore if archive columns don't exist yet
  }
}

// Subscribe to real-time updates for all customer transactions
let bookingUnsub = null
let ordersUnsub = null
let salesUnsub = null

function subscribeToBookings() {
  if (bookingUnsub) return

  // 1. Subscribe to Bookings (Reservations/Pre-orders)
  bookingUnsub = db.channel('admin-bookings-channel')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'bookings' },
      (payload) => {
        console.log('[v0] Booking update received:', payload)
        refreshAllRealTimeViews()
        
        // Show notification for new bookings
        if (payload.eventType === 'INSERT') {
            showMessage("New booking received!", "success")
        }
      }
    )
    .subscribe()

  // 2. Subscribe to Pending Orders (Active Kiosk/Walk-in Orders)
  if (!ordersUnsub) {
    ordersUnsub = db.channel('admin-orders-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_orders' },
        (payload) => {
          console.log('[v0] Order update received:', payload)
          refreshAllRealTimeViews()
          
          if (payload.eventType === 'INSERT') {
              showMessage("New active order received!", "info")
          }
        }
      )
      .subscribe()
  }

  // 3. Subscribe to Sales (Completed Transactions)
  if (!salesUnsub) {
    salesUnsub = db.channel('admin-sales-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sales' },
        (payload) => {
          console.log('[v0] Sales update received:', payload)
          refreshAllRealTimeViews()
          
          // Also refresh analytics/sales pages if visible
          if (document.getElementById('sales').style.display !== 'none') {
              if (window.renderSales) window.renderSales()
              if (window.renderProductSales) window.renderProductSales()
          }
        }
      )
      .subscribe()
  }
}

function refreshAllRealTimeViews() {
  // Refresh bookings list if on bookings page
  if (window.renderBookingsList && document.getElementById('bookings').style.display !== 'none') {
      window.renderBookingsList()
  }
  // Also refresh calendar if available
  if (window.renderCalendar) window.renderCalendar()
  // Refresh todos/notes if a date is selected
  if (typeof renderTodos === 'function' && typeof selectedTodoDate !== 'undefined' && selectedTodoDate) {
      renderTodos()
  }
  // Refresh cashier monitoring if visible
  if (document.getElementById('monitorings').style.display !== 'none') {
      if (window.loadCashierMonitoring) window.loadCashierMonitoring()
  }
}

// --- ADMIN LOGS ---
window.logAdminAction = async function(action, details) {
  try {
    const s = typeof getStaffSession === 'function' ? getStaffSession() : null
    if (!s) return
    const dbRef = db || getDB()
    if (!dbRef) return
    await dbRef.from('admin_logs').insert({
      admin_id: s.id,
      admin_name: s.full_name,
      action,
      details: details ? String(details) : null
    })
  } catch (e) { console.warn('[Admin] Log failed:', e) }
}

// --- CASHIER MONITORING ---
window.applyCashierMonitorRange = function() {
  const rangeEl = document.getElementById('cashierMonitorRange')
  const startEl = document.getElementById('cashierMonitorStart')
  const endEl = document.getElementById('cashierMonitorEnd')
  if (!rangeEl || !startEl || !endEl) {
    if (typeof loadCashierMonitoring === 'function') loadCashierMonitoring()
    return
  }

  const today = new Date()
  let startDate = new Date(today)
  let endDate = new Date(today)
  const range = rangeEl.value || 'daily'

  if (range === 'weekly') {
    const day = today.getDay()
    const diff = (day + 6) % 7
    startDate.setDate(today.getDate() - diff)
    endDate = new Date(startDate)
    endDate.setDate(startDate.getDate() + 6)
  } else if (range === 'monthly') {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1)
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  }

  startEl.value = startDate.toISOString().slice(0, 10)
  endEl.value = endDate.toISOString().slice(0, 10)
  if (typeof loadCashierMonitoring === 'function') loadCashierMonitoring()
}

window.loadCashierMonitoring = async function() {
  const container = document.getElementById('cashierMonitorContainer')
  if (!container) return
  container.innerHTML = '<p>Loading...</p>'
  const selectEl = document.getElementById('cashierMonitorUser')
  let startEl = document.getElementById('cashierMonitorStart')
  let endEl = document.getElementById('cashierMonitorEnd')
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const start = (startEl && startEl.value) || todayStr
  const end = (endEl && endEl.value) || todayStr
  const selectedCashier = selectEl ? selectEl.value : ''

  try {
    // 1. Get ONLY staff with role 'cashier'
    // This automatically excludes Administrators and Kitchen Staff
    const { data: staffDataRaw } = await db.from('staff').select('id, full_name, id_number, role').eq('role', 'cashier')
    const staffData = staffDataRaw || []
    
    // Find the primary cashier (Ralph Bayya) to attribute Admin transactions to
    const primaryCashier = staffData.find(s => s.full_name.toLowerCase().includes('ralph bayya')) || staffData[0]

    const cashierIds = staffData.map(s => s.id)
    const cashierIdNumbers = staffData.map(s => s.id_number).filter(id => id)
    const cashierNames = staffData.map(s => s.full_name)
    const cashierNameMap = {}
    staffData.forEach(s => cashierNameMap[s.id] = s.full_name)

    let sales = null
    let error = null
    let hasRemarks = true
    let hasItems = true
    let filterColumn = 'date'
    const startTs = new Date(`${start}T00:00:00`)
    const endTs = new Date(`${end}T23:59:59.999`)
    
    // 2. Fetch logs for this period
    const { data: logsData } = await db.from('admin_logs')
      .select('*')
      .gte('created_at', startTs.toISOString())
      .lte('created_at', endTs.toISOString())
      .order('created_at', { ascending: false });

    // 3. Fetch sales for this period
    const runQuery = async (cols) => {
      let query = db.from('sales').select(cols.join(', '))
      // Fetch broader range and filter more precisely in JS if needed, but for now we try both columns
      if (filterColumn === 'date') {
        query = query.gte('date', start).lte('date', end)
      } else {
        query = query.gte('timestamp', startTs.toISOString()).lte('timestamp', endTs.toISOString())
      }
      return await query
    }

    let selectCols = ['id', 'total', 'amount', 'cashier_id', 'cashier_name', 'timestamp', 'cashier_remarks', 'items', 'date', 'type', 'insufficient_payment', 'total_order_amount', 'amount_due', 'booking_id']
    for (let attempt = 0; attempt < 4; attempt++) {
      ;({ data: sales, error } = await runQuery(selectCols))
      if (!error) break
      const msg = String(error.message || '')
      let removed = false
      const possibleCols = ['cashier_remarks', 'items', 'date', 'type', 'insufficient_payment', 'total_order_amount', 'amount_due', 'booking_id']
      for (const col of possibleCols) {
        if ((msg.includes(col) || msg.includes('does not exist')) && selectCols.includes(col)) {
           selectCols = selectCols.filter(c => c !== col)
           removed = true
           if (col === 'cashier_remarks') hasRemarks = false
           if (col === 'items') hasItems = false
           if (col === 'date' && filterColumn === 'date') filterColumn = 'timestamp'
        }
      }
      if (!removed) break
    }
    if (error) throw error

    // 4. Filter data to ONLY show cashier transactions and activity
    let filteredSales = (sales || []).map(s => {
      // Attribute all non-cashier sales (like Administrators) to the primary cashier (Ralph Bayya)
      const isCashier = cashierIds.includes(s.cashier_id) || 
                       cashierIdNumbers.includes(s.cashier_id) || 
                       cashierNames.includes(s.cashier_name)
      
      if (!isCashier && primaryCashier) {
        return {
          ...s,
          cashier_id: primaryCashier.id,
          cashier_name: primaryCashier.full_name,
          _attributed_from: s.cashier_name || s.cashier_id // Keep original for reference if needed
        }
      }
      return s
    }).filter(s => {
      // Now all relevant sales are under a cashier ID
      return cashierIds.includes(s.cashier_id)
    })

    if (selectedCashier) {
      filteredSales = filteredSales.filter(s => {
        const key = s.cashier_id || s.cashier_name || 'Unassigned'
        const name = s.cashier_name || ''
        return key === selectedCashier || name === selectedCashier
      })
    }

    // Filter logs and attribute Admin logs to the primary cashier
    const filteredLogs = (logsData || []).map(l => {
      const isCashier = cashierIds.includes(l.admin_id) || 
                       cashierIdNumbers.includes(l.admin_id) || 
                       cashierNames.includes(l.admin_name)
      
      if (!isCashier && primaryCashier) {
        return {
          ...l,
          admin_id: primaryCashier.id,
          admin_name: primaryCashier.full_name,
          _attributed_from: l.admin_name || l.admin_id
        }
      }
      return l
    }).filter(l => {
      return cashierIds.includes(l.admin_id)
    })

    // Group logs by staff member
    const cashierLogs = {};
    filteredLogs.forEach(log => {
      const key = log.admin_id || log.admin_name || 'Unknown';
      if (!cashierLogs[key]) cashierLogs[key] = [];
      cashierLogs[key].push(log);
    });

    // 5. Update Cashier Dropdown
    if (selectEl) {
      const byKey = {}
      // ONLY use staffData which contains cashiers
      staffData && staffData.forEach(s => { byKey[s.id] = s.full_name })
      
      selectEl.innerHTML = '<option value="">All Cashiers</option>' +
        Object.entries(byKey).sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
          .map(([k, label]) => `<option value="${k}">${label}</option>`).join('')
      if (selectedCashier) selectEl.value = selectedCashier
    }

    const summaryEl = document.getElementById('cashierMonitorSummary')
    const dailyEl = document.getElementById('cashierMonitorDaily')
    if (summaryEl) summaryEl.innerHTML = ''
    if (dailyEl) dailyEl.innerHTML = ''
    
    if (filteredSales.length === 0 && filteredLogs.length === 0) {
      if (summaryEl) summaryEl.innerHTML = '<p style="color: var(--coffee-dark); text-align:center; padding: 20px;">No cashier activity found in this date range.</p>'
      container.innerHTML = ''
      return
    }

    // 6. Calculate Totals for Forecasting
    const rangeEl = document.getElementById('cashierMonitorRange')
    const rangeLabel = rangeEl && rangeEl.options[rangeEl.selectedIndex]
      ? rangeEl.options[rangeEl.selectedIndex].textContent
      : 'Daily'
    const grandTotalSales = filteredSales.reduce((sum, s) => sum + Number(s.total || s.amount || 0), 0)
    const grandCount = filteredSales.length

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="cashier-monitor-header" style="background: white; padding: 24px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); margin-bottom: 24px; border-left: 6px solid var(--accent-warm); display: flex; flex-direction: column; gap: 20px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px;">
            <div class="cashier-monitor-period">
              <span style="display: block; font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px;">Monitoring Period</span>
              <div style="display: flex; align-items: baseline; gap: 8px;">
                <strong style="font-size: 1.4rem; color: var(--coffee-dark);">${rangeLabel}</strong>
                <span class="cashier-monitor-range" style="font-size: 0.85rem; color: #aaa;">(${start} to ${end})</span>
              </div>
            </div>
            
            <div style="display: flex; gap: 40px; flex-wrap: wrap;">
              <div class="cashier-monitor-metric" style="background: #fff9f5; padding: 12px 20px; border-radius: 12px; border: 1px solid #fee2d5;">
                <span style="display: block; font-size: 0.7rem; color: #a0522d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;">Total Sales</span>
                <strong style="font-size: 1.6rem; color: var(--accent-warm);">PHP ${grandTotalSales.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
              </div>
              <div class="cashier-monitor-metric" style="background: #f8f9fa; padding: 12px 20px; border-radius: 12px; border: 1px solid #e9ecef;">
                <span style="display: block; font-size: 0.7rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;">Transaction Count</span>
                <strong style="font-size: 1.6rem; color: var(--coffee-dark);">${grandCount}</strong>
              </div>
            </div>
          </div>
          <div style="padding-top: 15px; border-top: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; color: #666;">
            <span style="background: #fffbe6; color: #856404; padding: 4px 10px; border-radius: 20px; border: 1px solid #ffeeba; font-weight: 600;">Forecasting Tip</span>
            Use these totals to predict peak hours and staffing needs for the next ${rangeLabel.toLowerCase()}.
          </div>
        </div>
      `
    }

    // 7. Grouping for Display
    const groups = {}
    // First, initialize groups for all active cashiers in staffData
    staffData.forEach(s => {
      groups[s.id] = { label: s.full_name, rows: [], logs: [], total: 0, count: 0, id_number: s.id_number }
    })

    filteredSales.forEach(s => {
      // Find which group this sale belongs to
      let groupKey = s.cashier_id
      // If s.cashier_id is an id_number, find the UUID
      if (!groups[groupKey]) {
        const staffByNum = staffData.find(st => st.id_number === s.cashier_id)
        if (staffByNum) groupKey = staffByNum.id
        else {
           // Try by name
           const staffByName = staffData.find(st => st.full_name === s.cashier_name)
           if (staffByName) groupKey = staffByName.id
        }
      }

      if (!groups[groupKey]) {
        // Fallback for unassigned or missing staff record
        const key = s.cashier_id || s.cashier_name || 'Unassigned'
        const label = s.cashier_name || s.cashier_id || 'Unassigned'
        groups[groupKey] = { label, rows: [], logs: [], total: 0, count: 0 }
      }

      groups[groupKey].rows.push(s)
      groups[groupKey].count += 1
      groups[groupKey].total += Number(s.total || s.amount || 0)
    })

    Object.keys(cashierLogs).forEach(key => {
      let groupKey = key
      if (!groups[groupKey]) {
        const staffByNum = staffData.find(st => st.id_number === key)
        if (staffByNum) groupKey = staffByNum.id
        else {
           const staffByName = staffData.find(st => st.full_name === key)
           if (staffByName) groupKey = staffByName.id
        }
      }

      if (!groups[groupKey]) {
        const logEntry = cashierLogs[key][0];
        const label = logEntry.admin_name || logEntry.admin_id || key;
        groups[groupKey] = { label, rows: [], logs: [], total: 0, count: 0 }
      }
      groups[groupKey].logs = cashierLogs[key]
    })

    container.innerHTML = Object.values(groups)
      .filter(g => (g.rows && g.rows.length > 0) || (g.logs && g.logs.length > 0)) // Only show cashiers with activity
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(group => {
        // Create unified activity list for interleaved sorting
        const activity = [];
        
        // Add sales to activity
        group.rows.forEach(s => {
          // Robust timestamp detection
          const ts = s.timestamp || s.sale_date || (s.date ? `${s.date}T00:00:00.000Z` : '');
          activity.push({
            type: 'sale',
            timestamp: ts,
            data: s
          });
        });
        
        // Add logs to activity
        group.logs.forEach(l => {
          const ts = l.created_at || '';
          activity.push({
            type: 'log',
            timestamp: ts,
            data: l
          });
        });
        
        // Sort activity by timestamp descending (recent on top)
        activity.sort((a, b) => {
          const timeA = new Date(a.timestamp).getTime();
          const timeB = new Date(b.timestamp).getTime();
          return timeB - timeA;
        });

        const activityRows = activity.map(item => {
          if (item.type === 'sale') {
            const s = item.data;
            let ts = '-';
            if (s.timestamp) {
              const d = new Date(s.timestamp);
              ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            let txId = s.id ? `#${s.id}` : (s.booking_id ? `#B${s.booking_id}` : '-');
            let typeBadge = "";
            if (s.type === 'preorder' || s.booking_id) {
              typeBadge = '<span style="background: #e3f2fd; color: #0d47a1; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 5px;">PRE-ORDER</span>';
            } else if (s.type === 'kiosk_order') {
              typeBadge = '<span style="background: #f1f8e9; color: #2e7d32; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 5px;">KIOSK</span>';
            }
            
            let items = [];
            if (hasItems && s.items) {
              try {
                items = typeof s.items === 'string' ? JSON.parse(s.items) : s.items;
                if (!Array.isArray(items)) items = [];
              } catch (_) { items = []; }
            }
            const qty = items.reduce((sum, i) => sum + Number(i.quantity || i.qty || 0), 0);
            const productList = items.length
              ? items.map(i => `<div style="margin-bottom: 2px;">• ${Number(i.quantity || i.qty || 1)}x ${i.name || i.product || 'Item'}</div>`).join("")
              : '-';
            const remarks = hasRemarks && s.cashier_remarks ? String(s.cashier_remarks) : '';
            
            // Refined amount details logic
            let amountDetails = `<strong>PHP ${Number(s.total || s.amount || 0).toFixed(2)}</strong>`;
            
            // If it's a pre-order record with 0.00 total but items exist, calculate it
            let actualTotal = Number(s.total || s.amount || 0);
            if (s.type === 'preorder' && actualTotal === 0 && items.length > 0) {
               actualTotal = items.reduce((sum, i) => {
                 const lineTotal = Number(i.amount || 0) || (Number(i.price || 0) * Number(i.quantity || i.qty || 1));
                 return sum + lineTotal;
               }, 0);
               amountDetails = `<strong>PHP ${actualTotal.toFixed(2)}</strong> <span style="font-size: 0.7rem; color: #888; display: block;">(Calculated)</span>`;
            }

            if (s.type === 'preorder' && s.total_order_amount > 0) {
               const paid = actualTotal;
               const due = Number(s.amount_due || 0);
               const fullTotal = Number(s.total_order_amount || 0);
               
               if (due > 0) {
                 amountDetails = `
                   <div style="color: #d9534f; font-weight: bold;">Paid: ₱${paid.toFixed(2)}</div>
                   <div style="color: #f0ad4e; font-size: 0.8rem;">Due: ₱${due.toFixed(2)}</div>
                   <div style="border-top: 1px solid #eee; margin-top: 4px; padding-top: 4px; font-size: 0.75rem; color: #888;">Total: ₱${fullTotal.toFixed(2)}</div>
                 `
               } else {
                 amountDetails = `
                   <div style="font-weight: bold; color: #2e7d32;">Paid: ₱${paid.toFixed(2)}</div>
                   <div style="font-size: 0.75rem; color: #5cb85c;">(Fully Paid)</div>
                 `
               }
            }

            return `<tr style="border-bottom: 1px solid #f5f5f5;">
                <td class="monitor-td" style="font-size: 0.85rem; color: #666;">${ts}</td>
                <td class="monitor-td" style="font-family: 'Courier New', monospace; font-size: 0.85rem;">${txId}${typeBadge}</td>
                <td class="monitor-td" style="text-align: center;">${qty || '-'}</td>
                <td class="monitor-td" style="font-size: 0.85rem; line-height: 1.4;">${productList}</td>
                <td class="monitor-td" style="white-space: nowrap;">${amountDetails}</td>
                <td class="monitor-td monitor-remarks" style="font-size: 0.8rem; color: #777; font-style: italic;">${remarks}</td>
              </tr>`;
          } else {
            const l = item.data;
            const d = new Date(l.created_at);
            const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let actionIcon = "⚙️";
            if (l.action.toLowerCase().includes("insufficient")) actionIcon = "⚠️";
            else if (l.action.toLowerCase().includes("completion") || l.action.toLowerCase().includes("received")) actionIcon = "✅";
            else if (l.action.toLowerCase().includes("status")) actionIcon = "📝";

            return `<tr style="background: #fafafa; border-bottom: 1px solid #eee;">
              <td class="monitor-td" style="font-size: 0.8rem; color: #999;">${ts}</td>
              <td class="monitor-td" colspan="2">
                <span style="background: #eee; color: #666; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: bold; text-transform: uppercase;">CASHIER ACTION</span>
              </td>
              <td class="monitor-td">
                <div style="display: flex; align-items: center; gap: 6px; font-weight: 600; color: #555; font-size: 0.85rem;">
                  <span>${actionIcon}</span> ${l.action}
                </div>
              </td>
              <td class="monitor-td" colspan="2" style="font-size: 0.8rem; color: #888; font-style: italic;">${l.details || ''}</td>
            </tr>`;
          }
        }).join('');

        return `
          <div class="cashier-monitor-group" style="margin-bottom: 40px; border: 1px solid #e0e0e0; border-radius: 16px; overflow: hidden; background: white; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
            <div class="cashier-monitor-group-header" style="background: linear-gradient(to right, #fdfaf8, #ffffff); padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee;">
              <div class="cashier-monitor-title" style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 40px; height: 40px; background: var(--accent-warm); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.2rem;">${group.label.charAt(0)}</div>
                <div>
                  <span style="display: block; font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em;">Cashier</span>
                  <strong style="font-size: 1.1rem; color: var(--coffee-dark);">${group.label}</strong>
                </div>
              </div>
              <div style="display: flex; gap: 30px;">
                <div class="cashier-monitor-metric">
                  <span style="display: block; font-size: 0.7rem; color: #999; text-transform: uppercase;">Transactions</span>
                  <strong style="font-size: 1.2rem; color: var(--coffee-dark);">${group.count}</strong>
                </div>
                <div class="cashier-monitor-metric">
                  <span style="display: block; font-size: 0.7rem; color: #999; text-transform: uppercase;">Total Sales</span>
                  <strong style="font-size: 1.2rem; color: var(--accent-warm);">PHP ${group.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                </div>
              </div>
            </div>
            <div style="overflow-x: auto;">
              <table class="monitor-table" style="width: 100%; border-collapse: collapse;">
                <thead>
                  <tr style="background: #f8f9fa; border-bottom: 2px solid #eee;">
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 120px;">Time/Date</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 180px;">ID / Type</th>
                    <th style="padding: 14px 20px; text-align: center; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 80px;">Qty</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em;">Action / Product</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em; width: 180px;">Total / Details</th>
                    <th style="padding: 14px 20px; text-align: left; font-size: 0.7rem; text-transform: uppercase; color: #999; letter-spacing: 0.1em;">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  ${activityRows || ''}
                  ${(!activityRows) ? '<tr><td colspan="6" style="padding: 40px; text-align: center; color: #bbb; font-style: italic;">No activity recorded for this cashier.</td></tr>' : ''}
                </tbody>
              </table>
            </div>
          </div>
        `
      }).join('')
  } catch (err) {
    console.error("Error loading cashier monitoring:", err)
    container.innerHTML = `<p style="color:red">Error: ${err.message}</p>`
  }
}

// --- ADMIN LOGS PAGE ---
window.loadAdminLogs = async function() {
  const container = document.getElementById('adminLogsContainer')
  if (!container) return
  container.innerHTML = '<p>Loading...</p>'
  const selectEl = document.getElementById('adminLogsUser')
  let startEl = document.getElementById('adminLogsStart')
  let endEl = document.getElementById('adminLogsEnd')
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const start = (startEl && startEl.value) || todayStr
  const end = (endEl && endEl.value) || todayStr
  const selectedAdmin = selectEl ? selectEl.value : ''

  try {
    // Dynamically fetch all admins and system_admins
    const { data: admins, error: adminErr } = await db.from('staff')
      .select('id, full_name')
      .in('role', ['system_admin', 'admin'])
    if (adminErr) throw adminErr
    
    const allowedAdminNames = (admins || []).map(a => a.full_name)
    const allowedAdminIds = (admins || []).map(a => a.id)

    let logs
    const { data: rawLogs, error } = await db.from('admin_logs')
      .select('*')
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    
    // Filter logs to only show administrators
    logs = (rawLogs || []).filter(l => allowedAdminNames.includes(l.admin_name) || allowedAdminIds.includes(l.admin_id))
    
    if (selectedAdmin) {
      logs = logs.filter(l => l.admin_id === selectedAdmin || l.admin_name === selectedAdmin)
    }
    if (selectEl) {
      const byId = {}
      if (admins) admins.forEach(a => { byId[a.id] = a.full_name })
      
      selectEl.innerHTML = '<option value="">All Admins</option>' +
        Object.entries(byId).sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
          .map(([id, name]) => `<option value="${id}">${name}</option>`).join('')
      if (selectedAdmin) selectEl.value = selectedAdmin
    }
    if (!logs || logs.length === 0) {
      container.innerHTML = '<p style="color: var(--coffee-dark);">No admin logs in date range.</p>'
      return
    }
    const rows = logs.map(l => {
      const ts = new Date(l.created_at).toLocaleString()
      return `<tr><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${ts}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${l.admin_name}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-dark);">${l.action}</td><td style="padding:8px; border-bottom:1px solid #eee; color: var(--coffee-medium);">${l.details || ''}</td></tr>`
    }).join('')
    container.innerHTML = `
      <table style="width:100%; border-collapse:collapse; color: var(--coffee-dark);">
        <thead><tr><th style="text-align:left; padding:8px; border-bottom:2px solid var(--coffee-dark);">Time</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Admin</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Action</th><th style="padding:8px; border-bottom:2px solid var(--coffee-dark);">Details</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger);">Error: ${e.message}. Ensure admin_logs table exists (run sql/cashier_monitoring_and_admin_logs.sql).</p>`
  }
}

// --- STAFF MANAGEMENT ---
window.loadStaffList = async function() {
  const container = document.getElementById('staffListContainer')
  if (!container) return
  container.innerHTML = '<p style="padding: 20px;">Loading...</p>'
  try {
    const { data: staff, error } = await db.from('staff').select('*').order('created_at', { ascending: false })
    if (error) throw error
    const canEdit = typeof canRegisterStaff === 'function' ? canRegisterStaff() : false
    const filtered = (staff || []).filter(s => staffArchiveMode ? s.archived === true : !s.archived)
    
    if (!filtered || filtered.length === 0) {
      container.innerHTML = `<p style="padding: 20px;">${staffArchiveMode ? 'No archived staff records.' : 'No staff registered.'}</p>`
      return
    }

    let tableHtml = `
      <table class="staff-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>ID Number</th>
            <th>Username</th>
            <th>Password</th>
            <th>Role</th>
            <th class="actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
    `

    filtered.forEach(s => {
      const isArchived = s.archived === true
      const canEditActive = canEdit && !isArchived
      const archiveBtn = (!isArchived && window.canRemoveStaff && canRemoveStaff(s))
        ? `<button onclick="removeStaff('${s.id}')" class="btn-delete-sm" title="Archive">Archive</button>`
        : ''
      const restoreBtn = isArchived
        ? `<button onclick="restoreStaff('${s.id}')" class="btn-edit-sm" title="Restore">Restore</button>`
        : ''
      
      tableHtml += `
        <tr>
          <td>
            <div style="font-weight:600; color:var(--coffee-dark);">${s.full_name}</div>
            <div style="font-size:11px; color:var(--coffee-medium);">${s.email || ''}</div>
          </td>
          <td><code>${s.id_number}</code></td>
          <td>${s.username || '-'}</td>
          <td><code style="background:#eee; padding:2px 4px; border-radius:3px;">${s.plain_password}</code></td>
          <td>
            <span class="badge-role role-${s.role}">${s.role.replace('_', ' ')}</span>
            ${s.is_system_admin ? '<span style="font-size:10px; display:block; color:#7b1fa2; font-weight:700;">SYSTEM ADMIN</span>' : ''}
            ${isArchived ? '<span class="badge-archived">ARCHIVED</span>' : ''}
          </td>
          <td class="actions-cell">
            <div style="display:flex; gap:6px; justify-content:flex-end;">
              ${canEditActive ? `<button onclick="toggleStaffEdit('${s.id}', true)" class="btn-edit-sm">Edit</button>` : ''}
              ${archiveBtn}
              ${restoreBtn}
            </div>
          </td>
        </tr>
        ${canEditActive ? `
        <tr id="staffEdit-${s.id}" style="display:none; background: #fdfaf8;">
          <td colspan="6" style="padding: 20px; border-bottom: 2px solid var(--accent-warm);">
            <div class="edit-staff-form">
              <div class="form-row compact-row">
                <div class="form-group">
                  <label>Full Name</label>
                  <input type="text" id="editStaffName-${s.id}" class="form-control" value="${s.full_name}">
                </div>
                <div class="form-group">
                  <label>ID Number</label>
                  <input type="text" id="editStaffId-${s.id}" class="form-control" value="${s.id_number}">
                </div>
              </div>
              <div class="form-row compact-row">
                <div class="form-group">
                  <label>Username</label>
                  <input type="text" id="editStaffUsername-${s.id}" class="form-control" value="${s.username || ''}">
                </div>
                <div class="form-group">
                  <label>Email</label>
                  <input type="email" id="editStaffEmail-${s.id}" class="form-control" value="${s.email || ''}">
                </div>
              </div>
              <div class="form-row compact-row">
                <div class="form-group">
                  <label>Role</label>
                  <select id="editStaffRole-${s.id}" class="form-control" data-system-admin="${s.is_system_admin ? 'true' : 'false'}" ${s.is_system_admin ? 'disabled' : ''}>
                    ${s.is_system_admin ? `<option value="system_admin">system_admin</option>` : ''}
                    <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>admin</option>
                    <option value="cashier" ${s.role === 'cashier' ? 'selected' : ''}>cashier</option>
                    <option value="kitchen_staff" ${s.role === 'kitchen_staff' ? 'selected' : ''}>kitchen_staff</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Current Password</label>
                  <input type="text" class="form-control" value="${s.plain_password || 'Not stored'}" readonly style="background:#f0f0f0;">
                </div>
                <div class="form-group">
                  <label>New Password (optional)</label>
                  <div class="password-input-wrapper">
                    <input type="password" id="editStaffPassword-${s.id}" class="form-control" placeholder="Enter to change password">
                  </div>
                </div>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                <div id="staffEditMsg-${s.id}" style="font-size:13px; font-weight:600;"></div>
                <div style="display:flex; gap:10px;">
                  <button onclick="toggleStaffEdit('${s.id}', false)" class="btn-secondary">Cancel</button>
                  <button onclick="saveStaffEdit('${s.id}')" class="btn-primary">Save Changes</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
        ` : ''}
      `
    })

    tableHtml += `</tbody></table>`
    container.innerHTML = tableHtml
  } catch (e) {
    container.innerHTML = `<p style="padding: 20px; color:var(--danger);">Error: ${e.message}</p>`
  }
}

window.toggleStaffArchiveView = () => {
  staffArchiveMode = !staffArchiveMode
  const btn = document.getElementById("toggleStaffArchiveBtn")
  if (btn) btn.textContent = staffArchiveMode ? "Show Active" : "Show Archived"
  if (window.loadStaffList) window.loadStaffList()
}

window.toggleStaffEdit = function(id, show) {
  const row = document.getElementById(`staffEdit-${id}`)
  if (row) row.style.display = show ? 'table-row' : 'none'
  const msgEl = document.getElementById(`staffEditMsg-${id}`)
  if (msgEl) msgEl.textContent = ''
}

window.togglePasswordVisibility = function(inputId, btn) {
  const input = document.getElementById(inputId)
  if (!input) return
  if (input.type === 'password') {
    input.type = 'text'
    btn.textContent = '🙈'
  } else {
    input.type = 'password'
    btn.textContent = '👁️'
  }
}

window.saveStaffEdit = async function(id) {
  const nameEl = document.getElementById(`editStaffName-${id}`)
  const idEl = document.getElementById(`editStaffId-${id}`)
  const userEl = document.getElementById(`editStaffUsername-${id}`)
  const emailEl = document.getElementById(`editStaffEmail-${id}`)
  const roleEl = document.getElementById(`editStaffRole-${id}`)
  const pwdEl = document.getElementById(`editStaffPassword-${id}`)
  const msgEl = document.getElementById(`staffEditMsg-${id}`)
  if (!nameEl || !idEl || !roleEl || !msgEl) return

  const fullName = nameEl.value.trim()
  const idNumber = idEl.value.trim()
  const username = userEl ? userEl.value.trim() : null
  const email = emailEl ? emailEl.value.trim() : null
  const isSystemAdmin = roleEl.dataset.systemAdmin === 'true'
  const role = isSystemAdmin ? 'system_admin' : roleEl.value
  const newPassword = pwdEl ? pwdEl.value : ''

  if (!fullName || !idNumber) {
    msgEl.textContent = 'Full name and ID number are required.'
    msgEl.style.color = 'var(--danger)'
    return
  }

  try {
    // Check for duplicates
    const { data: dupId } = await db.from('staff').select('id').eq('id_number', idNumber).neq('id', id).maybeSingle()
    if (dupId) throw new Error('ID number already exists.')

    if (username) {
      const { data: dupUser } = await db.from('staff').select('id').eq('username', username).neq('id', id).maybeSingle()
      if (dupUser) throw new Error('Username already exists.')
    }

    if (email) {
      const { data: dupEmail } = await db.from('staff').select('id').eq('email', email).neq('id', id).maybeSingle()
      if (dupEmail) throw new Error('Email already exists.')
    }

    const updates = { full_name: fullName, id_number: idNumber, role }
    updates.username = username || null
    updates.email = email || null
    
    if (newPassword) {
      if (typeof hashPassword !== 'function' || typeof generateSalt !== 'function') {
        throw new Error('Password utilities not available. Reload the page and try again.')
      }
      const salt = generateSalt()
      const password_hash = await hashPassword(newPassword, salt)
      updates.password_hash = password_hash
      updates.salt = salt
      updates.plain_password = newPassword // Store plain password for admin viewing
    }
    const { error } = await db.from('staff').update(updates).eq('id', id)
    if (error) {
      if (error.code === '23505') throw new Error('Username or ID number already exists.')
      throw error
    }
    if (window.logAdminAction) {
      await logAdminAction('Updated staff', `${fullName} (${idNumber})`)
    }
    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null
    if (sess && sess.id === id) {
      sess.full_name = fullName
      sess.id_number = idNumber
      sess.role = role
      setStaffSession(sess)
      const staffDisplay = document.getElementById('staffNameDisplay')
      if (staffDisplay) staffDisplay.textContent = sess.full_name + ' (' + sess.role + ')'
    }
    msgEl.textContent = 'Staff updated.'
    msgEl.style.color = 'var(--success)'
    if (pwdEl) pwdEl.value = ''
    loadStaffList()
  } catch (e) {
    msgEl.textContent = e.message || 'Update failed.'
    msgEl.style.color = 'var(--danger)'
  }
}

window.registerStaffSubmit = async function() {
  const id = document.getElementById('regStaffId')?.value?.trim()
  const name = document.getElementById('regStaffName')?.value?.trim()
  const user = document.getElementById('regStaffUsername')?.value?.trim()
  const email = document.getElementById('regStaffEmail')?.value?.trim()
  const pwd = document.getElementById('regStaffPassword')?.value
  const role = document.getElementById('regStaffRole')?.value
  const msgEl = document.getElementById('staffMessage')
  
  if (!msgEl) return
  if (!id || !name || !pwd) {
    msgEl.textContent = 'Please fill ID number, full name, and password'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
    return
  }
  if (pwd.length < 6) {
    msgEl.textContent = 'Password must be at least 6 characters'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
    return
  }
  
  try {
    const res = await staffRegister(id, name, pwd, role, user, email)
    if (!res.ok) {
      msgEl.textContent = res.message || 'Registration failed'
      msgEl.style.color = 'var(--danger)'
      msgEl.style.display = 'block'
      return
    }
    
    if (window.logAdminAction) await logAdminAction('Registered staff', `${name} (${id}) - ${role}`)
    msgEl.textContent = 'Staff registered successfully.'
    msgEl.style.color = 'var(--success)'
    msgEl.style.display = 'block'
    
    // Clear form
    document.getElementById('regStaffId').value = ''
    document.getElementById('regStaffName').value = ''
    document.getElementById('regStaffUsername').value = ''
    document.getElementById('regStaffEmail').value = ''
    document.getElementById('regStaffPassword').value = ''
    
    loadStaffList()
  } catch (e) {
    msgEl.textContent = e.message || 'Registration failed'
    msgEl.style.color = 'var(--danger)'
    msgEl.style.display = 'block'
  }
}

window.removeStaff = async function(id) {
  if (!confirm('Archive this staff account?')) return
  try {
    await safeUpdateRowAdmin('staff', { id }, { archived: true, archived_at: new Date().toISOString() })
    if (window.logAdminAction) await logAdminAction('Archived staff', `id: ${id}`)
    loadStaffList()
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = 'Staff archived.'; msgEl.style.color = 'var(--success)'; msgEl.style.display = 'block'; }
  } catch (e) {
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = e.message || 'Failed to archive'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
  }
}

window.restoreStaff = async function(id) {
  try {
    await safeUpdateRowAdmin('staff', { id }, { archived: false, archived_at: null })
    if (window.logAdminAction) await logAdminAction('Restored staff', `id: ${id}`)
    loadStaffList()
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = 'Staff restored.'; msgEl.style.color = 'var(--success)'; msgEl.style.display = 'block'; }
  } catch (e) {
    const msgEl = document.getElementById('staffMessage')
    if (msgEl) { msgEl.textContent = e.message || 'Failed to restore'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
  }
}

// Start initialization when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Staff name display and logout
  const staffDisplay = document.getElementById('staffNameDisplay')
  if (staffDisplay && getStaffSession) {
    const s = getStaffSession()
    if (s) staffDisplay.textContent = s.full_name + ' (' + s.role + ')'
  }
  // Hide Staff nav if user cannot register staff
  const navStaff = document.getElementById('navStaff')
  if (navStaff && typeof canRegisterStaff === 'function' && !canRegisterStaff()) navStaff.style.display = 'none'

  // Wait a bit for Supabase to initialize
  if (window.dbReady) {
    initializeAdmin()
  } else {
    window.onSupabaseReady = initializeAdmin
  }
});

// Helper function to map category IDs to names
function getCategoryName(id) {
  const cats = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
  return cats[id] || "Unknown"
}

// Message display
function showMessage(msg, type) {
  const container = document.getElementById("statusMessage")
  if (container) {
    container.innerHTML = `<div class="message ${type}">${msg}</div>`
    setTimeout(() => (container.innerHTML = ""), 2500)
  }
}

// Category ID base for auto-assignment
const CATEGORY_ID_BASE = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 }

// Current menu filter and search
let currentMenuFilter = "all"
let currentMenuSearch = ""
let menuArchiveMode = false

let staffArchiveMode = false

// Toggle add form visibility
window.toggleAddForm = () => {
  const form = document.getElementById("addForm")
  const btn = document.getElementById("toggleAddFormBtn")
  const menuControls = document.getElementById("menuControls")
  
  if (form.classList.contains("add-form-collapsed")) {
    form.classList.remove("add-form-collapsed")
    form.classList.add("add-form-expanded")
    if (btn) btn.textContent = "- Hide Form"
    if (menuControls) menuControls.style.display = "none" // Hide filters
  } else {
    form.classList.add("add-form-collapsed")
    form.classList.remove("add-form-expanded")
    if (btn) btn.textContent = "+ Add New Product"
    if (menuControls) menuControls.style.display = "flex" // Show filters
    window.resetForm()
  }
}

// Search menu products
window.searchMenu = (query) => {
  currentMenuSearch = query.toLowerCase().trim()
  loadMenu()
}

window.toggleMenuArchiveView = () => {
  menuArchiveMode = !menuArchiveMode
  const btn = document.getElementById("toggleMenuArchiveBtn")
  if (btn) btn.textContent = menuArchiveMode ? "Show Active" : "Show Archived"
  loadMenu()
}

// Filter menu by category
window.filterMenuCategory = (catId, btn) => {
  currentMenuFilter = String(catId)
  document.querySelectorAll("#menu .category-filter button").forEach((b) => b.classList.remove("active"))
  if (btn) btn.classList.add("active")
  loadMenu()
}

// Load sizes for datalist
async function loadSizesDatalist() {
  const datalist = document.getElementById("sizeList")
  if (!datalist) return

  try {
    const { data, error } = await db.from("products").select("size")
    if (error) throw error
    datalist.innerHTML = ""
    const sizes = new Set()
    data.forEach((d) => {
      if (d.size) sizes.add(d.size.trim())
    })
    sizes.forEach((size) => {
      const option = document.createElement("option")
      option.value = size
      datalist.appendChild(option)
    })
  } catch (err) {
    console.error("Error loading sizes:", err)
  }
}

// Update Product Preview
window.updatePreview = () => {
  const name = document.getElementById("name").value.trim() || "Product Name"
  const catId = document.getElementById("category_id").value
  const size = document.getElementById("size").value.trim() || "Size"
  const price = parseFloat(document.getElementById("price").value) || 0
  
  document.getElementById("previewName").textContent = name
  document.getElementById("previewCategory").textContent = getCategoryName(parseInt(catId))
  document.getElementById("previewSize").textContent = size
  document.getElementById("previewPrice").textContent = `₱${price.toFixed(2)}`
}

// Handle category change
window.handleCategoryChange = () => {
  const catId = document.getElementById("category_id").value
  const sizeInput = document.getElementById("size")
  
  if (catId === "5") { // Pastries
    sizeInput.value = "Regular"
    sizeInput.disabled = true
  } else {
    sizeInput.disabled = false
    // If it was "Regular" from a previous pastry selection, clear it
    if (sizeInput.value === "Regular") {
      sizeInput.value = ""
    }
  }
  window.updatePreview()
}

// Preview Image from File
window.previewImage = (input) => {
  const file = input.files[0]
  const previewImg = document.getElementById("previewImage")
  const noImg = document.getElementById("previewNoImage")

  if (file) {
    const reader = new FileReader()
    reader.onload = (e) => {
      previewImg.src = e.target.result
      previewImg.style.display = "block"
      noImg.style.display = "none"
    }
    reader.readAsDataURL(file)
  } else {
    previewImg.style.display = "none"
    noImg.style.display = "flex"
  }
}

// Preview image when editing an existing variant by URL
function previewImageFromUrl(url) {
  const previewImg = document.getElementById("previewImage")
  const noImg = document.getElementById("previewNoImage")
  if (previewImg) {
    previewImg.src = url || ""
    if (url) {
      previewImg.style.display = "block"
      if (noImg) noImg.style.display = "none"
    } else {
      previewImg.style.display = "none"
      if (noImg) noImg.style.display = "flex"
    }
  }
}

// Save Product
window.saveProduct = async () => {
  const categoryIdEl = document.getElementById("category_id")
  const productNameEl = document.getElementById("name")
  const productPriceEl = document.getElementById("price")
  const sizeEl = document.getElementById("size")
  const photoEl = document.getElementById("product_photo")

  // Reset errors
  const formElements = [categoryIdEl, productNameEl, productPriceEl, sizeEl, photoEl];
  if (formElements) {
    formElements.forEach(el => {
        if (el && el.classList) el.classList.remove("error");
    });
  }

  const category_id = Number.parseInt(categoryIdEl.value)
  const product_name = productNameEl.value.trim()
  const product_price = Number.parseFloat(productPriceEl.value)
  const size = sizeEl.value.trim()
  const photoFile = photoEl.files[0]
  const requireSize = category_id !== 5
  const isNewProduct = !productNameEl.disabled

  let hasError = false

  if (isNaN(category_id)) {
    categoryIdEl.classList.add("error")
    hasError = true
  }
  if (!product_name) {
    productNameEl.classList.add("error")
    hasError = true
  }
  if (isNaN(product_price) || product_price < 0) {
    productPriceEl.classList.add("error")
    hasError = true
  }
  if (requireSize && !size) {
    sizeEl.classList.add("error")
    hasError = true
  }
  // Require either File OR URL for new products
  if (isNewProduct && !photoFile) {
    photoEl.classList.add("error")
    hasError = true
  }

  if (hasError) {
    return showMessage("Please fill all required fields!", "error")
  }

  const btn = document.querySelector(".btn-primary[onclick='saveProduct()']") || document.getElementById("addBtn")
  if(btn) {
      btn.disabled = true
      btn.textContent = "Saving..."
  }

  const proceedAdd = async (pid, photoUrl = null) => {
    try {
        const { data: existingProducts, error: fetchError } = await db.from("products").select("*")
        if (fetchError) throw fetchError

        let existingPhotoUrl = null
        let existingCategoryId = category_id

        // Find existing product with same name
        if (existingProducts && Array.isArray(existingProducts)) {
            existingProducts.forEach((d) => {
              if (d.name.toLowerCase() === product_name.toLowerCase()) {
                if (d.image_url) existingPhotoUrl = d.image_url
                existingCategoryId = d.category_id
              }
            })
        }

        const data = {
          category_id: existingCategoryId,
          id: pid,
          name: product_name,
          price: product_price,
          size: category_id === 5 ? "Regular" : size,
          image_url: photoUrl || existingPhotoUrl || "",
        }

        const { error: insertError } = await db.from("products").insert([data])
        if (insertError) throw insertError
        if (window.logAdminAction) await logAdminAction('Added product', `${product_name} (${size}) - ₱${product_price}`)

        loadMenu()
        showMessage("Product added successfully!", "success")
        toggleAddForm()
        
        // Clear form
        window.resetForm()
        if(document.getElementById("previewImage")) document.getElementById("previewImage").style.display = "none"
        if(document.getElementById("previewNoImage")) document.getElementById("previewNoImage").style.display = "flex"

    } catch (err) {
        console.error("[v0] Error adding product:", err)
        showMessage("Failed to save product: " + err.message, "error")
    } finally {
        if(btn) {
            btn.disabled = false
            btn.textContent = "Add Product"
        }
    }
  }

  try {
      if (photoFile) {
        const timestamp = Date.now()
        const sanitizedName = product_name.replace(/[^a-z0-9]/gi, "_").toLowerCase()
        const fileName = `${sanitizedName}_${timestamp}`

        // Try uploading to 'product-photos'
        const { data, error } = await db.storage.from('product-photos').upload(fileName, photoFile)
        
        if (error) {
             console.warn("[v0] Storage upload failed, trying Base64 fallback:", error)
             // Fallback: Resize and save as Base64
             try {
                const base64Url = await resizeImage(photoFile)
                const pid = await getNextProductId(category_id)
                await proceedAdd(pid, base64Url)
                showMessage("Product added using offline mode (Storage blocked).", "success")
             } catch (resizeErr) {
                 console.error("Fallback failed:", resizeErr)
                 throw new Error("Upload failed and fallback failed: " + (resizeErr.message || "Image too large"))
             }
        } else {
             const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
             const pid = await getNextProductId(category_id)
             await proceedAdd(pid, publicUrl)
        }
      } else {
        // No photo file provided; for new products we already require a file.
        // Proceed without overriding image_url so existing/default will be used.
        const pid = await getNextProductId(category_id)
        await proceedAdd(pid, null)
      }
  } catch (error) {
      console.error("Error in saveProduct:", error)
      showMessage("Error: " + error.message, "error")
      if(btn) {
          btn.disabled = false
          btn.textContent = "Add Product"
      }
  }
}

// Navigation (Show Page)
window.showPage = (pg) => {
  document.querySelectorAll('.page').forEach(p => p.style.display='none')
  
  // Update sidebar active state
  document.querySelectorAll('.sidebar nav button').forEach(btn => {
    btn.classList.remove('active')
    if (btn.getAttribute('onclick').includes(`'${pg}'`)) {
      btn.classList.add('active')
    }
  })

  // Close any open modals when switching pages
  const resModal = document.getElementById('rescheduleModal')
  if(resModal) resModal.style.display = 'none'
  const rejModal = document.getElementById('rejectModal')
  if(rejModal) rejModal.style.display = 'none'

  const page = document.getElementById(pg)
  if(page) page.style.display='block'

  if (pg === 'bookings' && window.renderBookingsList) { 
    if(window.renderCalendar) window.renderCalendar()
    window.renderBookingsList()
  }
  if (pg === 'sales' && window.renderSales) window.renderSales()
  if (pg === 'analytics' && window.runDashboard) window.runDashboard()
  if (pg === 'reports' && window.renderReports) window.renderReports()
  if (pg === 'settings') window.loadPaymentSettings()
  if (pg === 'staff' && window.loadStaffList) window.loadStaffList()
  if (pg === 'monitorings') {
    if (window.showMonitoringsTab) showMonitoringsTab('adminLogs')
  }
}

  window.showMonitoringsTab = function(tab) {
    const adminPanel = document.getElementById('monitoringsAdminLogs')
    const cashierPanel = document.getElementById('monitoringsCashier')
    const adminBtn = document.getElementById('monTabAdminLogs')
    const cashierBtn = document.getElementById('monTabCashier')
  if (tab === 'adminLogs') {
    if (adminPanel) adminPanel.style.display = 'block'
    if (cashierPanel) cashierPanel.style.display = 'none'
    if (adminBtn) adminBtn.classList.add('active')
    if (cashierBtn) cashierBtn.classList.remove('active')
    if (window.loadAdminLogs) loadAdminLogs()
  } else {
    if (adminPanel) adminPanel.style.display = 'none'
    if (cashierPanel) cashierPanel.style.display = 'block'
    if (adminBtn) adminBtn.classList.remove('active')
      if (cashierBtn) cashierBtn.classList.add('active')
      if (window.loadCashierMonitoring) loadCashierMonitoring()
    }
  }

  function isMonitoringsVisible() {
    const page = document.getElementById('monitorings')
    return !!page && page.style.display !== 'none'
  }

  function subscribeToAdminLogsRealtime() {
    if (!db) return
    if (adminLogsUnsub && typeof adminLogsUnsub.unsubscribe === 'function') adminLogsUnsub.unsubscribe()
    adminLogsUnsub = db.channel('admin-logs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_logs' }, () => {
        if (!isMonitoringsVisible()) return
        const adminBtn = document.getElementById('monTabAdminLogs')
        if (adminBtn && adminBtn.classList.contains('active')) loadAdminLogs()
      })
      .subscribe()
  }

  function subscribeToCashierMonitoringRealtime() {
    if (!db) return
    if (cashierMonitorUnsub && typeof cashierMonitorUnsub.unsubscribe === 'function') cashierMonitorUnsub.unsubscribe()
    cashierMonitorUnsub = db.channel('cashier-monitoring-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, (payload) => {
        console.log("[Realtime] Sales change detected:", payload.eventType)
        if (!isMonitoringsVisible()) return
        loadCashierMonitoring()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_logs' }, (payload) => {
        console.log("[Realtime] Admin log change detected:", payload.eventType)
        if (!isMonitoringsVisible()) return
        loadCashierMonitoring()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (payload) => {
        console.log("[Realtime] Booking change detected:", payload.eventType)
        if (!isMonitoringsVisible()) return
        loadCashierMonitoring()
      })
      .subscribe()
  }
  
  // --- PROMOS MANAGEMENT ---
window.loadPromos = async function() {
  const tbody = document.getElementById("promoBody")
  if (!tbody) return
  tbody.innerHTML = '<tr><td colspan="3">Loading...</td></tr>'

  try {
    const { data: promos, error } = await db.from("promos").select("*").order("created_at", { ascending: false })
    if (error) throw error
    
    tbody.innerHTML = ""
    if (!promos || promos.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3">No promos found.</td></tr>'
      return
    }

    // Filter out expired promos
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const activePromos = promos.filter((p) => {
      if (!p.valid_until) return true // No expiry date = always active
      const expiryDate = new Date(p.valid_until)
      expiryDate.setHours(23, 59, 59, 999)
      return expiryDate >= today
    })

    if (activePromos.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3">No active promos found.</td></tr>'
      return
    }

    activePromos.forEach((p) => {
      const tr = document.createElement("tr")
      tr.innerHTML = `
        <td>${p.title || "Untitled"}</td>
        <td>${p.content || ""}</td>
        <td>${p.valid_until || "No Expiry"}</td>
        <td>
          <button onclick="editPromo('${p.id}')" class="btn-edit-sm">Edit</button>
          <button onclick="deletePromo('${p.id}')" class="btn-delete-sm">Delete</button>
        </td>
      `
      tbody.appendChild(tr)
    })
  } catch (err) {
    console.error("Error loading promos:", err)
    tbody.innerHTML = `<tr><td colspan="3" style="color:red">Error: ${err.message}</td></tr>`
  }
}

window.editPromo = async function(id) {
    try {
        const { data, error } = await db.from("promos").select("*").eq("id", id).single()
        if (error) throw error
        
        document.getElementById("promoTitle").value = data.title || ""
        document.getElementById("promoContent").value = data.content || ""
        document.getElementById("promoUntil").value = data.valid_until || ""
        
        // Set min date to today
        const now = new Date()
        const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
        document.getElementById("promoUntil").min = todayStr
        
        document.getElementById("promoEditId").value = data.id
        
        document.getElementById("addPromoBtn").style.display = "none"
        document.getElementById("updatePromoBtn").style.display = "inline-block"
        document.getElementById("cancelPromoBtn").style.display = "inline-block"
        
        window.scrollTo({ top: 0, behavior: "smooth" })
    } catch(err) {
        console.error("Error getting promo:", err)
        showMessage("Error loading promo details", "error")
    }
}

window.deletePromo = async function(id) {
    if(!confirm("Are you sure you want to delete this promo?")) return
    
    try {
        const { error } = await db.from("promos").delete().eq("id", id)
        if (error) throw error
        if (window.logAdminAction) await logAdminAction('Deleted promo', `id: ${id}`)
        showMessage("Promo deleted successfully", "success")
        loadPromos()
    } catch(err) {
        console.error("Error deleting promo:", err)
        showMessage("Error deleting promo", "error")
    }
}

function resetPromoForm() {
    document.getElementById("promoTitle").value = ""
    document.getElementById("promoContent").value = ""
    document.getElementById("promoUntil").value = ""
    
    // Set min date to today
    const now = new Date()
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    document.getElementById("promoUntil").min = todayStr
    
    document.getElementById("promoEditId").value = ""
    document.getElementById("addPromoBtn").style.display = "inline-block"
    document.getElementById("updatePromoBtn").style.display = "none"
    document.getElementById("cancelPromoBtn").style.display = "none"
}

// Promo Event Listeners
document.addEventListener("DOMContentLoaded", () => {
    const addBtn = document.getElementById("addPromoBtn")
    if (addBtn) {
        addBtn.addEventListener("click", async () => {
            const title = document.getElementById("promoTitle").value.trim()
            const content = document.getElementById("promoContent").value.trim()
            const valid_until = document.getElementById("promoUntil").value
            
            if (!title || !content) {
                return showMessage("Please enter title and content", "error")
            }
            
            if (valid_until) {
                const now = new Date()
                const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
                if (valid_until < todayStr) {
                    return showMessage("Valid until date cannot be in the past", "error")
                }
            }
            
            addBtn.disabled = true
            addBtn.textContent = "Adding..."
            
            try {
                const { error } = await db.from("promos").insert([{ title, content, valid_until: valid_until || null }])
                if (error) throw error
                if (window.logAdminAction) await logAdminAction('Added promo', title)
                showMessage("Promo added successfully", "success")
                resetPromoForm()
                loadPromos()
            } catch(err) {
                console.error("Error adding promo:", err)
                showMessage("Error adding promo: " + err.message, "error")
            } finally {
                addBtn.disabled = false
                addBtn.textContent = "Add Promo"
            }
        })
    }
    
    const updateBtn = document.getElementById("updatePromoBtn")
    if (updateBtn) {
        updateBtn.addEventListener("click", async () => {
            const id = document.getElementById("promoEditId").value
            const title = document.getElementById("promoTitle").value.trim()
            const content = document.getElementById("promoContent").value.trim()
            const valid_until = document.getElementById("promoUntil").value
            
            if (!id || !title || !content) return
            
            if (valid_until) {
                const now = new Date()
                const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
                if (valid_until < todayStr) {
                    return showMessage("Valid until date cannot be in the past", "error")
                }
            }
            
            updateBtn.disabled = true
            updateBtn.textContent = "Updating..."
            
            try {
                const { error } = await db.from("promos").update({ title, content, valid_until: valid_until || null }).eq("id", id)
                if (error) throw error
                if (window.logAdminAction) await logAdminAction('Updated promo', title)
                showMessage("Promo updated successfully", "success")
                resetPromoForm()
                loadPromos()
            } catch(err) {
                console.error("Error updating promo:", err)
                showMessage("Error updating promo", "error")
            } finally {
                updateBtn.disabled = false
                updateBtn.textContent = "Update Promo"
            }
        })
    }
    
    const cancelBtn = document.getElementById("cancelPromoBtn")
    if (cancelBtn) {
        cancelBtn.addEventListener("click", resetPromoForm)
    }
    
    // Initialize form state
    resetPromoForm()
})

// --- MENU MANAGEMENT ---
async function loadMenu() {
  const menuList = document.getElementById("menuList")
  if (!menuList) return
  menuList.innerHTML = ""

  try {
    const { data, error } = await db.from("products").select("*")
    if (error) {
      console.error("[v0] Error loading menu:", error)
      return
    }
    const allData = data || []
    const visibleData = allData.filter((d) => (menuArchiveMode ? d.archived === true : d.archived !== true))
    if (!visibleData || visibleData.length === 0) {
      menuList.innerHTML = menuArchiveMode
        ? '<div class="empty-menu">No archived products.</div>'
        : '<div class="empty-menu">No products added yet.</div>'
      return
    }

    // Group products by name
    const grouped = {}
    visibleData.forEach((d) => {
      const name = String(d.name || "").trim()
      const key = name.toLowerCase()

      if (!grouped[key]) {
        grouped[key] = {
          name: name,
          category_id: d.category_id,
          image_url: d.image_url || "",
          sizes: [],
        }
      }
      if (!grouped[key].image_url && d.image_url) {
        grouped[key].image_url = d.image_url
      }
      grouped[key].sizes.push({
        docId: d.id,
        size: d.size || "",
        price: Number(d.price || 0),
        id: d.id,
      })
    })

    const sortedGroups = Object.values(grouped).sort((a, b) => {
      const ca = Number(a.category_id || 0)
      const cb = Number(b.category_id || 0)
      if (ca !== cb) return ca - cb
      return a.name.localeCompare(b.name)
    })

    let filteredGroups =
      currentMenuFilter === "all"
        ? sortedGroups
        : sortedGroups.filter((g) => Number(g.category_id) === Number(currentMenuFilter))

    if (currentMenuSearch) {
      filteredGroups = filteredGroups.filter((g) => g.name.toLowerCase().includes(currentMenuSearch))
    }

    if (filteredGroups.length === 0) {
      menuList.innerHTML = currentMenuSearch
        ? '<div class="empty-menu">No products match your search.</div>'
        : '<div class="empty-menu">No products in this category.</div>'
      return
    }

    filteredGroups.forEach((group) => {
      const card = document.createElement("div")
      card.className = "product-card"
      group.sizes.sort((a, b) => a.price - b.price)

      const photoHTML = group.image_url
        ? `<img src="${group.image_url}" alt="${group.name}" class="product-photo" onerror="this.style.display='none'">`
        : '<div class="no-photo">No Photo</div>'

            const sizesHTML = group.sizes
        .map((s) => {
          const actionButtons = menuArchiveMode
            ? `<button onclick="restoreVariant('${s.docId}', '${group.name.replace(/'/g, "\\'")}')" class="btn-edit-sm">Restore</button>`
            : `<button onclick="editVariant('${s.docId}')" class="btn-edit-sm">Edit</button>
            <button onclick="deleteVariant('${s.docId}', '${group.name.replace(/'/g, "\\'")}')" class="btn-delete-sm">Archive</button>`
          return `
        <div class="size-row">
          <span class="size-label">${s.size || "Default"}</span>
          <span class="size-price">\u20B1${s.price.toFixed(2)}</span>
          <div class="size-actions">
            ${actionButtons}
          </div>
        </div>
      `
        })
        .join("")

      const productActions = menuArchiveMode
        ? `<button onclick="restoreEntireProduct('${group.name.replace(/'/g, "\\'")}')" class="btn-edit">Restore Product</button>`
        : `<button onclick="addSizeToProduct('${group.name.replace(/'/g, "\\'")}', ${group.category_id})" class="btn-add-size">+ Add Size</button>
            <button onclick="editProductPhoto('${group.name.replace(/'/g, "\\'")}')" class="btn-edit">Change Photo</button>
            <button onclick="deleteEntireProduct('${group.name.replace(/'/g, "\\'")}')" class="btn-delete">Archive All</button>`

      card.innerHTML = `
        <div class="product-header">
          <div class="product-photo-container">
            ${photoHTML}
          </div>
          <div class="product-info">
            <span class="product-category">${getCategoryName(Number(group.category_id))}</span>
            <h4 class="product-name">${group.name}</h4>
          </div>
          <div class="product-actions">
            ${productActions}
          </div>
        </div>
        <div class="sizes-list">
          <div class="sizes-header">
            <span>Size</span>
            <span>Price</span>
            <span>Actions</span>
          </div>
          ${sizesHTML}
        </div>
      `
      menuList.appendChild(card)
    })
  } catch (err) {
    console.error("[v0] Error loading menu:", err)
  }
}

// Generate next product ID based on category
async function getNextProductId(category_id) {
  const base = CATEGORY_ID_BASE[category_id] || 100
  try {
      // 1. Find max ID within the category
      const { data, error } = await db
        .from("products")
        .select("id")
        .eq("category_id", category_id)
      
      if (error) throw error
      
      let maxId = base - 1
      if (data) {
        data.forEach((d) => {
            const pid = Number(d.id || 0)
            if (pid > maxId) maxId = pid
        })
      }
      
      let nextId = maxId + 1

      // 2. Safety Check: Ensure this ID is not taken by ANY product (cross-category collision check)
      // This handles cases where an ID exists but has the wrong category_id
      let isTaken = true
      while (isTaken) {
          const { data: checkData } = await db.from("products").select("id").eq("id", nextId).single()
          if (checkData) {
              // ID exists! Increment and try again
              console.warn(`Collision detected for ID ${nextId}. Incrementing...`)
              nextId++
          } else {
              isTaken = false
          }
      }
      
      return nextId
  } catch (e) {
      console.warn("Error getting next product ID (using base):", e)
      return base
  }
}

// Reset form to default state
window.resetForm = function () {
  document.getElementById("formTitle").textContent = "Add New Product"
  document.getElementById("category_id").value = "1"
  document.getElementById("category_id").disabled = false
  document.getElementById("name").value = ""
  document.getElementById("name").disabled = false
  document.getElementById("price").value = ""
  document.getElementById("size").value = ""
  document.getElementById("size").disabled = false
  document.getElementById("product_photo").value = ""
  document.getElementById("editDocId").value = ""
  document.getElementById("addBtn").style.display = "inline-block"
  document.getElementById("updateBtn").style.display = "none"
  document.getElementById("cancelBtn").style.display = "none"
  window.handleCategoryChange()
}

// Add size to existing product
window.addSizeToProduct = (productName, categoryId) => {
  // Open form if collapsed
  const form = document.getElementById("addForm")
  const btn = document.getElementById("toggleAddFormBtn")
  form.classList.remove("add-form-collapsed")
  form.classList.add("add-form-expanded")
  if (btn) btn.textContent = "- Hide Form"

  document.getElementById("formTitle").textContent = `Add Size to "${productName}"`
  document.getElementById("category_id").value = categoryId
  document.getElementById("category_id").disabled = true
  document.getElementById("name").value = productName
  document.getElementById("name").disabled = true
  document.getElementById("price").value = ""
  document.getElementById("size").value = ""
  document.getElementById("product_photo").value = ""
  document.getElementById("addBtn").style.display = "inline-block"
  document.getElementById("updateBtn").style.display = "none"
  document.getElementById("cancelBtn").style.display = "inline-block"
  window.handleCategoryChange()
  window.scrollTo({ top: 0, behavior: "smooth" })
}

// Edit a specific product variant (size/price)
window.editVariant = async (id) => {
  try {
    const { data, error } = await db.from("products").select("*").eq("id", id).single()
    if (error) throw error

    // Open form if collapsed
    const form = document.getElementById("addForm")
    const btn = document.getElementById("toggleAddFormBtn")
    form.classList.remove("add-form-collapsed")
    form.classList.add("add-form-expanded")
    if (btn) btn.textContent = "- Hide Form"

    document.getElementById("formTitle").textContent = `Edit ${data.name} (${data.size})`
    document.getElementById("category_id").value = data.category_id
    document.getElementById("category_id").disabled = true
    document.getElementById("name").value = data.name
    document.getElementById("name").disabled = true
    document.getElementById("price").value = data.price
    document.getElementById("size").value = data.size
    document.getElementById("editDocId").value = data.id

    // Show/hide buttons
    document.getElementById("addBtn").style.display = "none"
    document.getElementById("updateBtn").style.display = "inline-block"
    document.getElementById("cancelBtn").style.display = "inline-block"

    // Handle photo preview
    if (data.image_url) {
      previewImageFromUrl(data.image_url)
    }

    window.scrollTo({ top: 0, behavior: "smooth" })
  } catch (err) {
    console.error("Error loading variant for edit:", err)
    showMessage("Failed to load product details.", "error")
  }
}

// Archive a specific product variant
window.deleteVariant = async (id, productName) => {
  if (!confirm(`Archive this size from ${productName}?`)) return

  try {
    await safeUpdateRowAdmin("products", { id }, { archived: true, archived_at: new Date().toISOString() })
    if (window.logAdminAction) await logAdminAction('Archived product variant', `${productName} id:${id}`)

    showMessage("Product size archived successfully!", "success")
    loadMenu()
  } catch (err) {
    console.error("Error archiving variant:", err)
    showMessage("Failed to archive product size.", "error")
  }
}

window.restoreVariant = async (id, productName) => {
  try {
    await safeUpdateRowAdmin("products", { id }, { archived: false, archived_at: null })
    if (window.logAdminAction) await logAdminAction('Restored product variant', `${productName} id:${id}`)
    showMessage("Product size restored successfully!", "success")
    loadMenu()
  } catch (err) {
    console.error("Error restoring variant:", err)
    showMessage("Failed to restore product size.", "error")
  }
}

// Update a specific product variant
window.updateVariant = async () => {
  const id = document.getElementById("editDocId").value
  const price = parseFloat(document.getElementById("price").value)
  const size = document.getElementById("size").value.trim()

  if (!id || isNaN(price) || !size) {
    return showMessage("Please fill all fields correctly.", "error")
  }

  const btn = document.getElementById("updateBtn")
  btn.disabled = true
  btn.textContent = "Saving..."

  try {
    const { error } = await db.from("products").update({ price, size }).eq("id", id)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Updated product variant', `id:${id} - ₱${price} (${size})`)

    showMessage("Product updated successfully!", "success")
    toggleAddForm()
    loadMenu()
  } catch (err) {
    console.error("Error updating variant:", err)
    showMessage("Failed to update product.", "error")
  } finally {
    btn.disabled = false
    btn.textContent = "Save Changes"
  }
}

// Change photo for all variants of a product (by shared name)
window.editProductPhoto = (productName) => {
  try {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/*"
    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      showMessage("Uploading photo...", "info")
      try {
        const timestamp = Date.now()
        const sanitizedName = String(productName || "product").replace(/[^a-z0-9]/gi, "_").toLowerCase()
        const fileName = `${sanitizedName}_${timestamp}`
        const { error: uploadError } = await db.storage.from("product-photos").upload(fileName, file)
        let publicUrl = null
        if (!uploadError) {
          const { data: urlData } = db.storage.from("product-photos").getPublicUrl(fileName)
          publicUrl = urlData?.publicUrl || null
        }
        if (!publicUrl) {
          // Fallback to base64 resize if storage blocked
          publicUrl = await resizeImage(file)
        }
        const { error: updErr } = await db.from("products").update({ image_url: publicUrl }).eq("name", productName)
        if (updErr) throw updErr
        showMessage("Photo updated for product.", "success")
        loadMenu()
      } catch (err) {
        console.error("Error changing product photo:", err)
        showMessage("Failed to change photo: " + (err.message || "Unknown error"), "error")
      }
    }
    input.click()
  } catch (e) {
    console.error("editProductPhoto error:", e)
  }
}

// Archive all variants of a product (by shared name)
window.deleteEntireProduct = async (productName) => {
  if (!confirm(`Archive ALL variants of "${productName}"?`)) return
  try {
    await safeUpdateRowAdmin("products", { name: productName }, { archived: true, archived_at: new Date().toISOString() })
    if (window.logAdminAction) await logAdminAction('Archived product', productName)
    showMessage("All variants archived.", "success")
    loadMenu()
  } catch (err) {
    console.error("Error archiving product group:", err)
    showMessage("Failed to archive product.", "error")
  }
}

window.restoreEntireProduct = async (productName) => {
  try {
    await safeUpdateRowAdmin("products", { name: productName }, { archived: false, archived_at: null })
    if (window.logAdminAction) await logAdminAction('Restored product', productName)
    showMessage("Product restored.", "success")
    loadMenu()
  } catch (err) {
    console.error("Error restoring product group:", err)
    showMessage("Failed to restore product.", "error")
  }
}

// Helper to resize image and get Data URL
function resizeImage(file, maxWidth = 400, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = height * (maxWidth / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

// --- CALENDAR LOGIC (Simplified) ---
let currentCalendarDate = new Date()

window.initCalendar = () => {
    window.renderCalendar(currentCalendarDate)
}

window.prevMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1)
    window.renderCalendar(currentCalendarDate)
}

window.nextMonth = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1)
    window.renderCalendar(currentCalendarDate)
}

let selectedTodoDate = null

window.renderCalendar = async (date = new Date()) => {
    const calendarBody = document.getElementById("calendarBody")
    const monthYear = document.getElementById("monthYear")
    if (!calendarBody || !monthYear) return

    const year = date.getFullYear()
    const month = date.getMonth()
    
    monthYear.textContent = new Date(year, month).toLocaleString('default', { month: 'long', year: 'numeric' })
    
    // Get bookings and todos for this month to mark dots
    const startOfMonth = new Date(year, month, 1).toISOString()
    const endOfMonth = new Date(year, month + 1, 0).toISOString()
    
    let bookings = []
    let todos = []

    try {
        const { data: bData } = await db.from("bookings")
            .select("date, status")
            .gte("date", startOfMonth.split('T')[0])
            .lte("date", endOfMonth.split('T')[0])
        bookings = bData || []
        
        const { data: tData } = await db.from("todos")
            .select("date, completed")
            .gte("date", startOfMonth.split('T')[0])
            .lte("date", endOfMonth.split('T')[0])
        todos = tData || []
    } catch (e) {
        console.warn("Error fetching calendar events", e)
    }

    const eventsByDate = {}
    bookings.forEach(b => {
        if (!eventsByDate[b.date]) eventsByDate[b.date] = { hasBooking: false, hasTodo: false }
        if (b.status !== 'rejected' && b.status !== 'cancelled') eventsByDate[b.date].hasBooking = true
    })
    todos.forEach(t => {
        if (!eventsByDate[t.date]) eventsByDate[t.date] = { hasBooking: false, hasTodo: false }
        if (!t.completed) eventsByDate[t.date].hasTodo = true
    })

    calendarBody.innerHTML = ""
    
    const firstDay = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    
    let dateCnt = 1
    for (let i = 0; i < 6; i++) {
        const row = document.createElement("tr")
        for (let j = 0; j < 7; j++) {
            const cell = document.createElement("td")
            if (i === 0 && j < firstDay) {
                // empty
            } else if (dateCnt > daysInMonth) {
                // empty
            } else {
                const currentDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dateCnt).padStart(2, '0')}`
                cell.textContent = dateCnt
                
                // Add dots
                const dots = document.createElement("div")
                dots.className = "calendar-dots"
                if (eventsByDate[currentDateStr]?.hasBooking) {
                    const d = document.createElement("span")
                    d.style.backgroundColor = "#e91e63" // Pink for booking
                    dots.appendChild(d)
                }
                if (eventsByDate[currentDateStr]?.hasTodo) {
                    const d = document.createElement("span")
                    d.style.backgroundColor = "#2196f3" // Blue for note
                    dots.appendChild(d)
                }
                cell.appendChild(dots)

                // Selection logic
                if (selectedTodoDate === currentDateStr) {
                    cell.classList.add("selected")
                }
                
                cell.onclick = () => selectDate(currentDateStr, cell)
                dateCnt++
            }
            row.appendChild(cell)
        }
        calendarBody.appendChild(row)
        if (dateCnt > daysInMonth) break
    }
}

function selectDate(dateStr, cellElement) {
    selectedTodoDate = dateStr
    document.querySelectorAll("#calendar td").forEach(td => td.classList.remove("selected"))
    if (cellElement) cellElement.classList.add("selected")
    
    document.getElementById("todoSection").style.display = "block"
    document.getElementById("selectedDateDisplay").textContent = dateStr
    
    document.getElementById("todoInput").disabled = false
    document.getElementById("addTodoBtn").disabled = false
    
    renderTodos()
}

// --- BOOKINGS ---
window.renderBookingsList = async () => {
  const tbody = document.getElementById("bookingsBody")
  if (!tbody) return
  
  const filterStatus = document.getElementById("bookingStatusFilter")?.value || "all"
  const filterType = document.getElementById("bookingTypeFilter")?.value || "all"
  const searchQuery = document.getElementById("bookingSearch")?.value?.toLowerCase() || ""

  try {
    // 1. Fetch data from both tables
    const [bookingsRes, ordersRes] = await Promise.all([
      db.from("bookings").select("*").order("created_at", { ascending: false }),
      db.from("pending_orders").select("*").order("created_at", { ascending: false })
    ])

    if (bookingsRes.error) throw bookingsRes.error
    if (ordersRes.error) throw ordersRes.error

    const allData = []

    // 2. Unify data
    if (bookingsRes.data) {
      bookingsRes.data.forEach(d => allData.push({ ...d, source: 'bookings' }))
    }
    if (ordersRes.data) {
      ordersRes.data.forEach(d => allData.push({ ...d, source: 'pending_orders', type: 'active_orders' }))
    }

    tbody.innerHTML = ""
    
    if (allData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:#999;">No customer transactions found.</td></tr>'
      return
    }

    let hasPendingGlobal = false
    const filteredData = allData.filter((d) => {
      const status = d.status || 'pending'
      if (status === 'pending') hasPendingGlobal = true
      
      const isArchived = d.archived === true
      const type = d.type || ""
      
      // Status filtering logic
      let matchStatus = false
      if (filterStatus === "all") {
        // "All Active" = not archived AND not in terminal states
        matchStatus = !isArchived && !['completed', 'rejected', 'cancelled'].includes(status)
      } else if (filterStatus === "archived") {
        matchStatus = isArchived || ['completed', 'rejected', 'cancelled'].includes(status)
      } else {
        matchStatus = (status === filterStatus)
      }

      // Type filtering logic
      let matchType = true
      if (filterType === "booking") {
        matchType = (type !== "preorder" && type !== "active_orders")
      } else if (filterType === "preorder") {
        matchType = (type === "preorder")
      }

      // Search filtering logic
      let matchSearch = true
      if (searchQuery) {
        const itemsRaw = d.items || "[]"
        let itemsText = ""
        try {
          const parsedItems = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw
          itemsText = (parsedItems || []).map(i => i.name || "").join(" ").toLowerCase()
        } catch(e) {}
        
        const searchData = [
          d.customer_id,
          d.customer_name,
          d.id,
          status,
          type,
          itemsText
        ].join(" ").toLowerCase()
        
        matchSearch = searchData.includes(searchQuery)
      }

      return matchStatus && matchType && matchSearch
    })

    const warningEl = document.getElementById("pendingWarning")
    if (warningEl) {
      warningEl.style.display = hasPendingGlobal ? "block" : "none"
    }

    if (filteredData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px; color:#999;">No matches for current filters.</td></tr>'
      return
    }

    // Sort: 1. Most recent date (desc), 2. Most recent time (desc), 3. Status priority
    const priorityOrder = { pending: 0, accepted: 1, confirmed: 2, preparing: 3, ready: 4, cancelled: 5, completed: 6, rejected: 7 }
    filteredData.sort((a, b) => {
      // 1. Sort by Date (Most recent first)
      const dateA = a.date || a.created_at?.slice(0, 10) || "0000-00-00"
      const dateB = b.date || b.created_at?.slice(0, 10) || "0000-00-00"
      if (dateA !== dateB) return dateB.localeCompare(dateA)

      // 2. Sort by Time (Most recent first)
      const timeA = a.time || a.created_at?.slice(11, 16) || "00:00"
      const timeB = b.time || b.created_at?.slice(11, 16) || "00:00"
      if (timeA !== timeB) return timeB.localeCompare(timeA)

      // 3. Sort by Status Priority
      const statusA = priorityOrder[a.status?.toLowerCase()] !== undefined ? priorityOrder[a.status?.toLowerCase()] : 999
      const statusB = priorityOrder[b.status?.toLowerCase()] !== undefined ? priorityOrder[b.status?.toLowerCase()] : 999
      return statusA - statusB
    })

    // Fetch customer names
    const customerIds = [...new Set(filteredData.map(b => b.customer_id).filter(Boolean))]
    const { data: customersData } = customerIds.length > 0 
      ? await db.from("customers").select("id, name, email").in("id", customerIds)
      : { data: [] }
    
    const customerMap = {}
    if (customersData) {
      customersData.forEach(c => { map[c.id] = c.name || c.email || c.id })
    }

    filteredData.forEach((d) => {
      const name = d.customer_name || customerMap[d.customer_id] || d.customer_id || "Guest"
      const dateStr = d.date || d.created_at?.slice(0, 10) || ""
      const timeStr = d.time || d.created_at?.slice(11, 16) || ""
      const type = d.type || ""
      
      let typeDisplay = "Booking"
      if (type === "preorder") typeDisplay = "Pre-order"
      else if (type === "active_orders") typeDisplay = "Active Order"
    
      let paymentInfo = "Cash"
      if (d.payment_method === 'online') {
          paymentInfo = `<span style="color:#2196F3; font-weight:bold;">Online</span>`
          if (d.proof_of_payment) {
              paymentInfo += `<br><a href="${d.proof_of_payment}" target="_blank" style="font-size:0.85em; text-decoration:underline;">View Receipt</a>`
          } else {
              paymentInfo += `<br><span style="font-size:0.85em; color:red;">No Receipt</span>`
          }
      } else if (d.payment_method === 'cash') {
          paymentInfo = "Cash"
      } else if (d.source === 'pending_orders') {
          paymentInfo = d.is_paid ? "Paid" : "Unpaid"
      }
      
      let itemsDetails = ""
      let calculatedTotal = Number(d.total || 0)
      try {
          const itemsRaw = typeof d.items === 'string' ? JSON.parse(d.items || "[]") : (d.items || [])
          if (Array.isArray(itemsRaw)) {
            itemsDetails = itemsRaw.map(it => `<div style="font-size:0.9em;">• ${it.qty || it.quantity || 1}x ${it.name}</div>`).join("")
            // Point 6 Fallback: If total is 0, calculate it from items
            if (calculatedTotal === 0 && itemsRaw.length > 0) {
              calculatedTotal = itemsRaw.reduce((sum, it) => sum + (Number(it.price || 0) * Number(it.qty || it.quantity || 1)), 0)
            }
          } else {
            itemsDetails = String(d.items || "-")
          }
      } catch (e) { itemsDetails = String(d.items || "-") }

      const totalDisplay = calculatedTotal > 0 ? `₱${Number(calculatedTotal).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"
      const rawStatus = d.status || "pending"
      let displayStatus = rawStatus.toUpperCase()
      let badgeClassStatus = rawStatus.toLowerCase()
      
      // If status is PAID or ACCEPTED, show as PREPARING to match kitchen dashboard
      if (rawStatus === 'paid' || rawStatus === 'PAID' || rawStatus === 'accepted' || rawStatus === 'ACCEPTED') {
          displayStatus = 'PREPARING'
          badgeClassStatus = 'preparing'
      }
      
      const tr = document.createElement("tr")
      
      let actionBtns = ""
      const isTerminal = ['completed', 'rejected', 'cancelled'].includes(rawStatus) || d.archived === true
      
      if (isTerminal) {
        // Archived/Terminal states: Only Delete button
        const sourceTable = d.source === 'pending_orders' ? 'pending_orders' : 'bookings'
        actionBtns = `<div class="booking-actions">
          <button onclick="deleteBooking('${d.id}', '${sourceTable}')" class="btn-action btn-remove" title="Delete record">Delete</button>
        </div>`
      } else if (rawStatus === "accepted" || rawStatus === "ACCEPTED" || rawStatus === "preparing" || rawStatus === "ready" || rawStatus === "paid" || rawStatus === "PAID") {
        // Specifically for Accepted/Preparing/Ready/Paid: Cancel and Reschedule (Kitchen handles Completion)
        if (d.source === 'pending_orders') {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateOrderStatus('${d.id}', 'cancelled')" class="btn-action btn-reject" title="Cancel Order">Cancel</button>
            <button onclick="showMessage('Kiosk orders cannot be rescheduled.', 'info')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>
          </div>`
        } else {
          actionBtns = `<div class="booking-actions">
            <button onclick="openRejectModal('${d.id}')" class="btn-action btn-reject" title="Cancel Booking">Cancel</button>
            <button onclick="rescheduleBooking('${d.id}', '${d.date}', '${d.time}')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>
          </div>`
        }
      } else {
        // Pending status: Accept, Reject, Reschedule
        if (d.source === 'pending_orders') {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateOrderStatus('${d.id}', 'accepted')" class="btn-action btn-accept" title="Accept">Accept</button>
            <button onclick="updateOrderStatus('${d.id}', 'rejected')" class="btn-action btn-reject" title="Reject">Reject</button>
            <button onclick="showMessage('Kiosk orders cannot be rescheduled.', 'info')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>
          </div>`
        } else {
          actionBtns = `<div class="booking-actions">
            <button onclick="updateBookingStatus('${d.id}', 'accepted')" class="btn-action btn-accept" title="Accept">Accept</button>
            <button onclick="openRejectModal('${d.id}')" class="btn-action btn-reject" title="Reject">Reject</button>
            <button onclick="rescheduleBooking('${d.id}', '${d.date}', '${d.time}')" class="btn-action btn-reschedule" title="Reschedule">Reschedule</button>
          </div>`
        }
      }
      
      tr.innerHTML = `
        <td><strong>${name}</strong></td>
        <td>${dateStr}</td>
        <td>${timeStr}</td>
        <td><span class="type-tag ${type}">${typeDisplay}</span></td>
        <td>${paymentInfo}</td>
        <td class="items-cell">${itemsDetails}</td>
        <td style="font-weight:bold;">${totalDisplay}</td>
        <td><span class="badge badge-${badgeClassStatus}">${displayStatus}</span></td>
        <td>${actionBtns}</td>
      `
      tbody.appendChild(tr)
    })
  } catch (err) {
    console.error("[v0] Error loading transactions:", err)
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--danger);">Error loading customer transactions.</td></tr>`
  }
}

window.openRejectModal = (bookingId) => {
  const modal = document.getElementById("rejectModal")
  if (modal) {
      document.getElementById("rejectBookingId").value = bookingId
      // Set default selection
      const radios = document.getElementsByName("rejectReason")
      radios.forEach(r => r.checked = false)
      if (radios.length > 0) {
        radios[0].checked = true
      }
      // Hide custom reason input
      const otherInput = document.getElementById("rejectReasonOther")
      if (otherInput) otherInput.style.display = "none"
      modal.style.display = "flex"
  }
}

window.closeRejectModal = () => {
    const modal = document.getElementById("rejectModal")
    if (modal) modal.style.display = "none"
}

window.updateRejectReason = () => {
    const selectedReason = document.querySelector('input[name="rejectReason"]:checked')?.value
    const otherInput = document.getElementById("rejectReasonOther")
    if (otherInput) {
      if (selectedReason === "Other") {
          otherInput.style.display = "block"
          otherInput.focus()
      } else {
          otherInput.style.display = "none"
      }
    }
}

window.confirmReject = () => {
    console.log("[v0] confirmReject called");
    const bookingId = document.getElementById("rejectBookingId").value
    const selectedReason = document.querySelector('input[name="rejectReason"]:checked')
    
    if (!selectedReason) {
        showMessage("Please select a rejection reason.", "error")
        return
    }
    
    let reason = selectedReason.value
    if (reason === "Other") {
        const otherInput = document.getElementById("rejectReasonOther")
        reason = (otherInput && otherInput.value.trim()) || "Admin Rejected"
        if (!reason || reason === "Admin Rejected") {
            showMessage("Please enter a custom reason.", "error")
            return
        }
    }
    
    safeUpdateRowAdmin("bookings", { id: bookingId }, { 
        status: "rejected",
        rejection_reason: reason,
        archived: true,
        archived_at: new Date().toISOString()
    })
    .then(() => {
      showMessage("Booking rejected.", "success")
      window.closeRejectModal()
      window.renderBookingsList()
    })
    .catch((err) => {
      console.error("[v0] Error rejecting booking:", err)
      showMessage("Failed to reject booking.", "error")
    })
}

function buildAutoCashierRemark({ source, paymentMethod, itemCount, total, discount, insufficient }) {
  const parts = []
  parts.push(source || "transaction")
  if (paymentMethod) parts.push("payment:" + paymentMethod)
  if (Number.isFinite(itemCount)) parts.push("items:" + itemCount)
  if (Number.isFinite(total)) parts.push("total:" + Number(total).toFixed(2))
  if (Number.isFinite(discount) && Number(discount) > 0) parts.push("discount:" + Number(discount).toFixed(2))
  if (insufficient) parts.push("insufficient")
  return "Auto: " + parts.join(" | ")
}

async function recordBookingSale(booking) {
    if (!booking || booking.type !== 'preorder') return;
    const bookingId = booking.id;
    
    // Check if already in sales to avoid double counting
    const { data: existingSales } = await db.from("sales").select("id").eq("booking_id", bookingId);
    if (existingSales && existingSales.length > 0) {
        console.log("[System Log] Pre-order already in Sales:", bookingId);
        return;
    }

    console.log("[System Log] Recording Pre-order in Sales:", bookingId);
    let items = booking.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items) } catch (e) { items = [] }
    }
    items = Array.isArray(items) ? items : [];

    const salesItems = items.map(i => ({
      id: i.id || i.product_id || "",
      name: i.name || "Unknown",
      category_id: i.category_id || null,
      quantity: Number(i.quantity || i.qty || 1),
      amount: (Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1))) * (Number(i.quantity || i.qty || 1))
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    let total = Number(booking.total || 0);

    // Get staff session for cashier_id/name
    const sess = typeof getStaffSession === 'function' ? getStaffSession() : null;

    // Fallback: Calculate total from items if it's 0 or missing
    if (total === 0 && salesItems.length > 0) {
      total = salesItems.reduce((sum, item) => sum + item.amount, 0);
    }

    const itemCount = salesItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0);
    const cashierRemark = buildAutoCashierRemark({
      source: "preorder",
      paymentMethod: booking.payment_method || "cash",
      itemCount,
      total: total,
      discount: Number(booking.discount || 0),
      insufficient: booking.insufficient_payment === true
    });

    const salesPayload = {
      items: JSON.stringify(salesItems),
      total: total,
      amount: total,
      timestamp: new Date().toISOString(),
      sale_date: new Date().toISOString(),
      date: dateStr,
      payment_method: booking.payment_method || 'cash',
      status: 'completed',
      type: 'preorder',
      booking_id: bookingId,
      ...(sess && { cashier_id: sess.id, cashier_name: sess.full_name }),
      cashier_remarks: cashierRemark
    };

    const tryInsertSales = async (payload) => {
      const { error } = await db.from("sales").insert(payload);
      return error || null;
    };

    let currentPayload = { ...salesPayload };
    let salesErr = await tryInsertSales(currentPayload);
    let attempt = 0;
    while (salesErr && attempt < 10) {
      const msg = String(salesErr.message || "");
      let removedField = false;
      const columns = ['discount', 'items', 'total', 'timestamp', 'date', 'amount', 'sale_date', 'payment_method', 'status', 'type', 'booking_id', 'cashier_id', 'cashier_name'];
      for (const col of columns) {
        const colNameInMsg = msg.includes(`"${col}"`) || msg.includes(`'${col}'`) || msg.includes(` ${col} `);
        const doesNotExist = msg.includes("does not exist") || msg.includes("Could not find");
        const isGenerated = msg.includes("cannot insert a non-DEFAULT value");
        if (colNameInMsg && (doesNotExist || isGenerated) && currentPayload[col] !== undefined) {
          delete currentPayload[col];
          removedField = true;
          break;
        }
      }
      if (!removedField) break;
      salesErr = await tryInsertSales(currentPayload);
      attempt++;
    }
    
    if (!salesErr) console.log("[System Log] Pre-order Sales Record Success");
    else console.error("[System Log] Pre-order Sales Record Failed:", salesErr);
}

window.updateBookingStatus = async (bookingId, newStatus) => {
  if (newStatus === 'accepted') {
    try {
        // 1. Get the booking details first
        const { data: bookingData, error: fetchError } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (fetchError) throw fetchError
        if (!bookingData) throw new Error("Booking not found")

        const date = bookingData.date
        const time = bookingData.time

        // 2. Query for conflicts
        // MODIFIED: Pre-orders are never rejected and don't cause rejections.
        // Table bookings (visits) are 1 per date.
        
        let conflictFound = false
        const toReject = []

        if (bookingData.type !== 'preorder') {
            const { data: conflicts, error: conflictError } = await db.from("bookings")
                .select("*")
                .eq("date", date)
                // Removed .eq("time", time) to enforce date-level uniqueness for tables
            
            if (conflictError) throw conflictError

            conflicts.forEach(otherData => {
                if (otherData.id === bookingId) return // Skip self

                // Ignore pre-orders (they can coexist)
                if (otherData.type === 'preorder') return

                if (otherData.status === 'accepted') {
                    conflictFound = true
                } else if (otherData.status === 'pending') {
                    toReject.push(otherData.id)
                }
            })
        }

        if (conflictFound) {
            showMessage("Cannot accept: Another booking is already accepted for this slot.", "error")
            return
        }

        // 3. Reject pending conflicts
        if (toReject.length > 0) {
            await Promise.all(toReject.map(id => 
                db.from("bookings").update({
                    status: 'rejected',
                    rejection_reason: "Already booked."
                }).eq("id", id)
            ))
        }

        // 4. Accept current booking
        const { error: updateError } = await db.from("bookings").update({ status: 'accepted' }).eq("id", bookingId)
        if (updateError) throw updateError
        if (window.logAdminAction) await logAdminAction('Booking status', `Accepted booking #${bookingId}`)

        // NEW: Record online pre-orders in Sales when accepted
        const { data: acceptedBooking } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (acceptedBooking && acceptedBooking.type === 'preorder' && acceptedBooking.payment_method === 'online') {
            console.log("[System Log] Recording Online Pre-order in Sales (Accepted):", bookingId)
            await recordBookingSale(acceptedBooking)
        }

        showMessage("Booking accepted! Conflicting pending bookings rejected.", "success")
        window.renderBookingsList()

    } catch (err) {
        console.error("[v0] Error updating booking status:", err)
        showMessage("Failed to update booking status.", "error")
    }
  } else {
    try {
      const payload = { status: newStatus }
      if (["completed", "rejected", "cancelled"].includes(newStatus)) {
        payload.archived = true
        payload.archived_at = new Date().toISOString()
      }
      await safeUpdateRowAdmin("bookings", { id: bookingId }, payload)
      if (window.logAdminAction) await logAdminAction('Booking status', `#${bookingId} → ${newStatus}`)

      // Record sale and award points if completed
      if (newStatus === 'completed') {
        const { data: booking } = await db.from("bookings").select("*").eq("id", bookingId).single()
        if (booking && booking.type === 'preorder') {
          // 1. Record in Sales
          await recordBookingSale(booking);

          // 2. Record in Orders History
          let items = booking.items
          if (typeof items === 'string') {
            try { items = JSON.parse(items) } catch (e) { items = [] }
          }
          items = Array.isArray(items) ? items : []
          
          const ordersPayload = items.map(i => ({
            customer_id: String(booking.customer_id || "preorder"),
            product_id: i.id || i.product_id || "",
            name: i.name || "Unknown",
            quantity: Number(i.quantity || i.qty || 1),
            price: Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1)) || 0,
            category_id: i.category_id || null,
            timestamp: new Date(),
            payment_method: booking.payment_method || 'cash',
            status: 'completed'
          }))
          
          await db.from("orders").insert(ordersPayload)

          // 3. Award Points
          let custId = null
          if (booking.customer_id) {
            const { data: c } = await db.from("customers")
              .select("id, loyalty_points, loyalty_card")
              .or(`email.eq.${booking.customer_id},contact.eq.${booking.customer_id}`)
              .maybeSingle()
            if (c) custId = c
          }

          if (custId) {
            const points = 1
            const newPoints = (custId.loyalty_points || 0) + points
            await db.from("customers").update({ loyalty_points: newPoints }).eq("id", custId.id)
            await db.from("loyalty_history").insert({
              customer_id: custId.id,
              loyalty_card: custId.loyalty_card,
              points: points,
              source: "preorder",
              order_id: bookingId,
              total: Number(booking.total || 0),
              timestamp: new Date()
            })
          }
        }
      }

      showMessage(`Booking ${newStatus}!`, "success")
      window.renderBookingsList()
    } catch (err) {
      console.error("[v0] Error updating booking:", err)
      showMessage("Failed to update booking.", "error")
    }
  }
}

window.toggleArchiveBooking = (bookingId, archiveStatus) => {
  db.from("bookings")
    .update({ archived: archiveStatus })
    .eq("id", bookingId)
    .then(({ error }) => {
      if (error) throw error
      const action = archiveStatus ? "archived" : "restored"
      showMessage(`Booking ${action}!`, "success")
      window.renderBookingsList()
    })
    .catch((err) => {
      console.error("[v0] Error updating booking archive status:", err)
      showMessage("Failed to update booking.", "error")
    })
}

window.updateOrderStatus = async (orderId, newStatus) => {
  try {
    const payload = { status: newStatus }
    if (['completed', 'rejected', 'cancelled'].includes(newStatus)) {
      payload.archived = true
      payload.archived_at = new Date().toISOString()
    }
    const { error } = await db.from("pending_orders").update(payload).eq("id", orderId)
    if (error) throw error
    if (window.logAdminAction) await logAdminAction('Order status', `Updated order #${orderId} to ${newStatus}`)
    showMessage(`Order #${orderId} updated to ${newStatus}`, "success")
    window.renderBookingsList()
  } catch (err) {
    console.error("[v0] Error updating order status:", err)
    showMessage("Failed to update order status.", "error")
  }
}

window.deleteBooking = (id, source = 'bookings', skipConfirm = false) => {
  const table = source === 'pending_orders' ? 'pending_orders' : 'bookings'
  const proceed = skipConfirm || confirm(`Delete this ${source === 'pending_orders' ? 'order' : 'booking'}?`)
  
  if (proceed) {
    db.from(table)
      .delete()
      .eq("id", id)
      .then(({ error }) => {
        if (error) throw error
        showMessage("Record deleted!", "success")
        window.renderBookingsList()
        // Also refresh notepad/todos if it's currently rendered
        if (typeof renderTodos === 'function' && document.getElementById('todoBody')) {
          renderTodos()
        }
        // Also refresh calendar dots
        if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      })
      .catch((err) => {
        console.error("[v0] Error deleting record:", err)
        showMessage("Failed to delete record.", "error")
      })
  }
}

// --- RESCHEDULE BOOKING ---
window.rescheduleBooking = async (bookingId, currentDate, currentTime) => {
  if (!bookingId || !currentDate || !currentTime) return;
  
  // Calculate next day
  const dateObj = new Date(currentDate);
  dateObj.setDate(dateObj.getDate() + 1);
  const nextDay = dateObj.toISOString().split('T')[0];
  
  const proceed = confirm(`Move this booking to the next day (${nextDay}) at ${currentTime}?`);
  if (!proceed) return;

  try {
    // 1. Get current data for logging
    const { data: oldBooking, error: fetchErr } = await db.from("bookings").select("*").eq("id", bookingId).single();
    if (fetchErr) throw fetchErr;

    // 2. Update booking
    const { error: updateErr } = await db.from("bookings")
      .update({
        date: nextDay,
        time: currentTime,
        status: "accepted", // Automatically accept if rescheduled
        rescheduled: true
      })
      .eq("id", bookingId);
    
    if (updateErr) throw updateErr;

    // 3. Log reschedule
    const logPayload = {
      booking_id: bookingId,
      old_date: currentDate,
      new_date: nextDay,
      old_time: currentTime,
      new_time: currentTime,
      rescheduled_at: new Date().toISOString()
    }
    
    const { error: logErr } = await db.from("booking_reschedule_logs").insert([logPayload]);
    if (logErr) {
        console.warn("Could not log to dedicated table, logging to admin_logs:", logErr.message);
        if (window.logAdminAction) {
            await logAdminAction('Booking Rescheduled', `Booking #${bookingId} moved from ${currentDate} to ${nextDay}`);
        }
    }

    showMessage(`Rescheduled to ${nextDay}`, "success");
    window.renderBookingsList();
    if (window.renderCalendar) window.renderCalendar(currentCalendarDate);
  } catch (err) {
    console.error("Error rescheduling:", err);
    showMessage("Failed to reschedule: " + err.message, "error");
  }
}

window.closeRescheduleModal = () => {
  const modal = document.getElementById("rescheduleModal")
  if (modal) modal.style.display = "none"
}

// --- TODOS ---
let isTodoSubmitting = false
window.addTodo = () => {
  console.log("addTodo function called");
  if (isTodoSubmitting) return
  if (!selectedTodoDate) return alert("Select a date first")
  const input = document.getElementById("todoInput")
  const task = input.value.trim()
  
  const btn = document.getElementById("addTodoBtn")
  if (btn) btn.disabled = true
  isTodoSubmitting = true

  if (task) {
    db.from("todos")
      .insert([{
        date: selectedTodoDate,
        task,
        priority: 'medium', // Default priority since dropdown is removed
        completed: false,
        timestamp: new Date().toISOString(),
      }])
      .then(({ error }) => {
        if (error) throw error
        input.value = ""
        renderTodos()
        showMessage("Note added!", "success")
        isTodoSubmitting = false
        if (btn) btn.disabled = false
        // Re-render calendar to update badges
        window.renderCalendar(currentCalendarDate)
      })
      .catch((err) => {
        console.error("[v0] Error adding note:", err)
        alert("Error adding note: " + (err.message || err))
        showMessage("Failed to add note: " + (err.message || err), "error")
        isTodoSubmitting = false
        if (btn) btn.disabled = false
      })
  } else {
    alert("Please enter a note description")
    isTodoSubmitting = false
    if (btn) btn.disabled = false
  }
}

window.completeTodo = (todoId) => {
  db.from("todos")
    .delete()
    .eq("id", todoId)
    .then(({ error }) => {
      if (error) throw error
      renderTodos()
      // Re-render calendar to update badges
      if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      showMessage("Note completed and removed!", "success")
    })
    .catch((err) => {
      console.error("[v0] Error completing note:", err)
      showMessage("Failed to complete note.", "error")
    })
}

window.deleteTodo = (todoId) => {
  db.from("todos")
    .delete()
    .eq("id", todoId)
    .then(({ error }) => {
      if (error) throw error
      renderTodos()
      // Re-render calendar to update badges
      if (window.renderCalendar) window.renderCalendar(currentCalendarDate)
      showMessage("Note deleted!", "success")
    })
    .catch((err) => {
      console.error("[v0] Error deleting note:", err)
      showMessage("Failed to delete note.", "error")
    })
}

function renderTodos() {
  const tbody = document.getElementById("todoBody")
  if (!tbody) return
  tbody.innerHTML = ""
  if (!selectedTodoDate) return

  // Fetch Todos and Bookings in parallel
  Promise.all([
    db.from("todos")
      .select("*")
      .eq("date", selectedTodoDate)
      .eq("completed", false),
    db.from("bookings")
      .select("*")
      .eq("date", selectedTodoDate)
  ])
  .then(([{ data: todosData, error: todosError }, { data: bookingsData, error: bookingsError }]) => {
    if (todosError) throw todosError
    if (bookingsError) throw bookingsError

    const items = []

    // Process Todos
    if (todosData) {
        todosData.forEach((d) => {
          items.push({ 
            type: 'todo',
            id: d.id, 
            ...d,
            sortPriority: { high: 0, medium: 1, low: 2 }[d.priority] || 1
          })
        })
    }

    // Process Bookings
    if (bookingsData) {
        bookingsData.forEach((b) => {
          // Only show pending or accepted bookings
          if (b.status === 'rejected' || b.status === 'cancelled') return

          let taskDescription = ""
          if (b.type === 'preorder') {
            let itemsText = ""
            try {
              const parsed = typeof b.items === 'string' ? JSON.parse(b.items || "[]") : (b.items || [])
              if (Array.isArray(parsed)) {
                itemsText = parsed.map(it => `${it.qty || it.quantity || 1}x ${it.name}`).join(", ")
              } else {
                itemsText = String(b.items || "-")
              }
            } catch (e) { itemsText = String(b.items || "-") }
            
            taskDescription = `<div style="font-weight:600; color:#2196F3;">[PRE-ORDER] Pick up: ${b.time}</div>
                               <div style="font-size:0.9em; color:#666;">Items: ${itemsText}</div>
                               <div style="font-size:0.85em; color:#888;">Customer: ${b.customer_id}</div>`
          } else {
            taskDescription = `<div style="font-weight:600; color:#795548;">[BOOKING] Check-in: ${b.time}</div>
                               <div style="font-size:0.85em; color:#888;">Customer: ${b.customer_id}</div>`
          }

          items.push({
            type: 'booking',
            id: b.id,
            priority: 'high', // Bookings are high priority
            task: taskDescription,
            sortPriority: 1 // Equivalent to high
          })
        })
    }

    if (items.length === 0) {
      const tr = document.createElement("tr")
      tr.innerHTML = '<td colspan="2" style="text-align:center;color:#999;padding:20px">No notes or bookings for this date</td>'
      tbody.appendChild(tr)
      return
    }

    // Sort by priority
    items.sort((a, b) => a.sortPriority - b.sortPriority)

    items.forEach((item) => {
      const tr = document.createElement("tr")
      
      let actions = ""

      if (item.type === 'todo') {
        actions = `<button onclick="window.deleteTodo('${item.id}')" style="background:#d97c4d;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Delete</button>`
      } else {
        // Booking styling
        actions = `
          <button onclick="window.deleteBooking('${item.id}', 'bookings', true)" style="background:#d97c4d;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Delete</button>
        `
      }

      tr.innerHTML = `<td>${item.task}</td><td>${actions}</td>`
      tbody.appendChild(tr)
    })
  })
  .catch((err) => {
    console.error("[v0] Error loading todos/bookings:", err)
    if (err.message && err.message.includes("todos")) {
        alert("Database Error: 'todos' table missing. Please run the SQL script.")
    }
  })
}

// --- PAYMENT SETTINGS ---
window.previewAdminQr = (input) => {
    const file = input.files[0]
    const previewImg = document.getElementById("adminQrPreview")
    const placeholder = document.getElementById("adminQrPlaceholder")
    
    if (file) {
        const reader = new FileReader()
        reader.onload = (e) => {
            previewImg.src = e.target.result
            previewImg.style.display = "block"
            placeholder.style.display = "none"
        }
        reader.readAsDataURL(file)
    }
}

window.savePaymentSettings = async () => {
    const fileInput = document.getElementById("adminQrCode")
    const file = fileInput.files[0]
    const btn = document.querySelector("#settings .btn-primary")
    
    if (btn) {
        btn.disabled = true
        btn.textContent = "Saving..."
    }

    try {
        let qrUrl = null

        // 1. Upload new QR if selected
        if (file) {
            const timestamp = Date.now()
            const fileName = `admin_qr_${timestamp}`
            const { data, error } = await db.storage.from('product-photos').upload(fileName, file)
            
            if (error) throw error
            
            const { data: { publicUrl } } = db.storage.from('product-photos').getPublicUrl(fileName)
            qrUrl = publicUrl
        } else {
            // Keep existing URL if image is visible
            const previewImg = document.getElementById("adminQrPreview")
            if (previewImg.style.display !== "none" && previewImg.src) {
                qrUrl = previewImg.src
            }
        }

        // 2. Save to Settings table
        if (qrUrl) {
            const { error } = await db.from('settings').upsert({ 
                key: 'admin_qr_code', 
                value: qrUrl,
                updated_at: new Date().toISOString()
            })
            if (error) throw error
            if (window.logAdminAction) await logAdminAction('Saved payment settings', 'Updated QR code')
            
            showMessage("Payment settings saved!", "success")
        } else {
             showMessage("No QR code to save.", "info")
        }

    } catch (err) {
        console.error("Error saving payment settings:", err)
        showMessage("Failed to save settings: " + err.message, "error")
    } finally {
        if (btn) {
            btn.disabled = false
            btn.textContent = "Save Settings"
        }
    }
}

window.loadPaymentSettings = async () => {
    try {
        const { data, error } = await db.from('settings').select('*').eq('key', 'admin_qr_code').single()
        
        if (data && data.value) {
            const previewImg = document.getElementById("adminQrPreview")
            const placeholder = document.getElementById("adminQrPlaceholder")
            
            if (previewImg && placeholder) {
                previewImg.src = data.value
                previewImg.style.display = "block"
                placeholder.style.display = "none"
            }
        }
    } catch (err) {
        // Ignore error if setting doesn't exist yet
        console.log("No payment settings found or error:", err)
    }
}



