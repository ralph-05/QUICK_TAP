// kitchen/kitchen.js

let db = null;
let knownOrderIds = new Set();
let knownPreorderIds = new Set();
let kitchenPollInterval = null;
const PANEL_COLOR_COUNT = 8;

function getStatusKey(order) {
    if (!order) return 'pending';
    const s = String(order.status || "").toLowerCase();
    
    // Insufficient orders always go to Pending until paid
    if (s === 'insufficient' || order.insufficient) return 'pending';
    
    // Once paid or accepted, they move to Preparing
    if (s === 'accepted' || s === 'paid') return 'preparing';
    
    return s;
}

function stripInsufficientPrefix(value) {
    if (typeof value !== 'string') return value;
    const stripped = value.replace(/^\[INSUFFICIENT[^\]]*\]\s*/i, "").trim();
    return stripped || value;
}

function isDbReady() {
    return db !== null && db !== undefined;
}

function initializeKitchen() {
    db = getDB();
    if (!db) {
        console.warn('[v0] Database not ready, retrying...');
        setTimeout(initializeKitchen, 100);
        return;
    }
    console.log('[v0] Kitchen initialized');
    
    // Initial Load
    refreshDashboard();
    
    // Subscribe to changes
    subscribeToChanges();
    
    // Polling fallback every 3 seconds for faster sync
    if (!kitchenPollInterval) {
        kitchenPollInterval = setInterval(refreshDashboard, 3000);
    }
}

async function refreshDashboard() {
    if (!isDbReady()) return;
    
    try {
        // Fetch Walk-ins and Kiosk Orders
        // Include 'pending', 'ACCEPTED', 'INSUFFICIENT' to ensure kitchen sees them
        const { data: pendingOrders, error: pendingError } = await db
            .from("pending_orders")
            .select("*")
            .in("status", ["pending", "ACCEPTED", "INSUFFICIENT", "PAID", "preparing", "ready", "accepted", "insufficient", "paid"]);
        
        if (pendingError) throw pendingError;

        // Fetch Pre-orders
        const { data: preorders, error: preorderError } = await db
            .from("bookings")
            .select("*")
            .eq("type", "preorder")
            .in("status", ["pending", "ACCEPTED", "INSUFFICIENT", "PAID", "preparing", "ready", "accepted", "insufficient", "paid"]);

        if (preorderError) throw preorderError;

        // Collect all unique customer IDs (could be contact or email)
        const customerIds = new Set();
        [...(pendingOrders || []), ...(preorders || [])].forEach(o => {
            if (o.customer_id && o.customer_id !== 'GUEST') {
                customerIds.add(o.customer_id);
            }
        });

        // Fetch customer names
        const customerMap = {};
        if (customerIds.size > 0) {
            const { data: customers, error: custError } = await db
                .from("customers")
                .select("name, contact, email")
                .or(`contact.in.(${Array.from(customerIds).join(',')}),email.in.(${Array.from(customerIds).join(',')})`);
            
            if (!custError && customers) {
                customers.forEach(c => {
                    if (c.contact) customerMap[c.contact] = c.name;
                    if (c.email) customerMap[c.email] = c.name;
                });
            }
        }

        renderDashboard(pendingOrders || [], preorders || [], customerMap);
    } catch (err) {
        console.error("Error refreshing kitchen dashboard:", err);
    }
}

function isInsufficientOrder(o) {
    try {
        const s = String(o.status || "").toLowerCase();
        if (s === 'paid') return false; // PAID orders are no longer insufficient
        if (s === 'insufficient') return true;
        if (s === 'ready' || s === 'completed') return false;
        const notesText = String(o.insufficient_notes || o.notes || "");
        if (/\bpayment confirmed at\b/i.test(notesText) || /\-\s*paid\b/i.test(notesText)) return false;
        const remaining = getKitchenRemainingAmount(o);
        if (remaining > 0) return true;
        if (isInsufficientFlag(o) || isInsufficientType(o)) return true;
        if (/insufficient/i.test(notesText)) return true;
        if (/insufficient/i.test(String(o.customer_id || ""))) return true;
    } catch (_) {}
    return false;
}

function shouldSuppressKitchenLine(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    return /insufficient|remaining balance|payment incomplete/i.test(value);
}

function isInsufficientFlag(o) {
    const raw = o ? o.insufficient_payment : null;
    return raw === true || raw === 1 || String(raw).toLowerCase() === 'true';
}

function isInsufficientType(o) {
    return String(o && o.type || '').toLowerCase() === 'insufficient';
}

function parseRemainingFromText(text) {
    const safeText = String(text || "");
    if (!safeText) return 0;
    if (/\bpayment confirmed at\b/i.test(safeText) || /\-\s*paid\b/i.test(safeText)) return 0;
    let match = safeText.match(/remaining balance[:\s]*[^\d]*([\d,.]+)\b/i);
    if (!match) match = safeText.match(/still need(?:ed)?[:\s]*[^\d]*([\d,.]+)\b/i);
    if (!match && /insufficient/i.test(safeText)) {
        match = safeText.match(/insufficient[^\d]*([0-9]+(?:\.[0-9]{1,2})?)/i);
    }
    if (!match) match = safeText.match(/(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)\s*([\d,.]+)\b/i);
    if (!match) return 0;
    const num = parseFloat(String(match[1] || '').replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
}

function parsePaidAmountFromNotes(text) {
    const safeText = String(text || "");
    if (!safeText) return 0;
    const amountMatches = Array.from(safeText.matchAll(/amount:\s*(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)?\s*([\d,.]+)/gi));
    const paidMatches = Array.from(safeText.matchAll(/paid[:\s]*(?:\u20B1|PHP|Php|P|\u00E2\u201A\u00B1)?\s*([\d,.]+)/gi));
    let raw = null;
    if (amountMatches.length > 0) raw = amountMatches[amountMatches.length - 1][1];
    if (!raw && paidMatches.length > 0) raw = paidMatches[paidMatches.length - 1][1];
    const value = Number(String(raw || "").replace(/,/g, ""));
    return Number.isFinite(value) ? value : 0;
}

/** Parse insufficient amount from notes when insufficient_amount_needed column is missing or 0. */
function parseInsufficientAmountFromNotes(o) {
    const fromColumn = Number(o.insufficient_amount_needed || 0);
    if (fromColumn > 0) return fromColumn;
    const notesText = String(o.insufficient_notes || o.notes || '');
    const fromNotes = parseRemainingFromText(notesText);
    if (fromNotes > 0) return fromNotes;
    const fromCustomer = parseRemainingFromText(o.customer_id || '');
    if (fromCustomer > 0) return fromCustomer;
    return 0;
}

function getKitchenRemainingAmount(o) {
    const status = String(o && o.status || "").toLowerCase();
    const fromColumn = Number(o.insufficient_amount_needed || 0);
    const fromNotes = parseInsufficientAmountFromNotes(o);
    let remaining = Math.max(fromColumn, fromNotes);
    if (remaining <= 0 && (status === 'insufficient' || isInsufficientFlag(o) || isInsufficientType(o))) {
        const total = Number(o.total || 0);
        const paid = parsePaidAmountFromNotes(o.insufficient_notes || o.notes || "");
        if (total > 0 && paid > 0) remaining = Math.max(0, total - paid);
        else if (total > 0) remaining = total;
    }
    return remaining;
}

function renderDashboard(pendingOrders, preorders, customerMap) {
    const colPending = document.getElementById("col-pending");
    const colPreparing = document.getElementById("col-preparing");
    const colReady = document.getElementById("col-ready");
    
    if (!colPending || !colPreparing || !colReady) return;

    colPending.innerHTML = "";
    colPreparing.innerHTML = "";
    colReady.innerHTML = "";

    const now = new Date();
    
    // Combine and process orders
    let allOrders = [];

    // Process Pending Orders (Walk-ins/Kiosk)
    pendingOrders.forEach(order => {
        let customerName = stripInsufficientPrefix(customerMap[order.customer_id] || order.customer_id);
        
        // Refined Walk-in Name Logic: Only show if it's not a generic 'Guest' or null
        if (!customerName || customerName === 'GUEST' || customerName === 'null') {
            customerName = ""; // Empty string means don't show
        }

        let label = 'WALK-IN';
        if (order.type === 'kiosk') label = 'KIOSK';
        if (order.type === 'redemption') label = 'REDEMPTION';

        allOrders.push({
            id: order.id,
            orderNumber: order.order_number || String(order.id).slice(-4),
            source: 'pending_orders',
            type: order.type || 'walk-in',
            status: order.status,
            items: order.items,
            timestamp: new Date(order.timestamp || order.created_at),
            total: order.total,
            customer: customerName,
            customer_id: order.customer_id,
            priority: 0, // Base priority
            label: label,
            insufficient: isInsufficientOrder(order),
            insufficient_amount: getKitchenRemainingAmount(order),
            insufficient_notes: order.insufficient_notes || "",
            currently_preparing: order.currently_preparing === true
        });
    });

    // Process Pre-orders
    preorders.forEach(order => {
        const isInsufficient = isInsufficientOrder(order)
        if (order.status === 'pending' && !isInsufficient) return
        const pickupDate = new Date(`${order.date}T${order.time}`);
        const diffMs = pickupDate - now;
        const diffMins = Math.floor(diffMs / 60000);
        
        // Date check: Today vs Tomorrow Early Morning (8:00 - 8:30 AM)
        const orderDateStr = order.date; // YYYY-MM-DD
        
        const localNow = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
        const todayStr = localNow.toISOString().split('T')[0];
        
        const tomorrow = new Date(now.getTime() + (24 * 60 * 60 * 1000));
        const localTomorrow = new Date(tomorrow.getTime() - (tomorrow.getTimezoneOffset() * 60000));
        const tomorrowStr = localTomorrow.toISOString().split('T')[0];
        
        let isToday = (orderDateStr === todayStr);
        let isTomorrow = (orderDateStr === tomorrowStr);
        
        // If not today and not tomorrow, don't show it yet unless insufficient or already preparing/ready
        if (!isInsufficient && !isToday && !isTomorrow && order.status !== 'preparing' && order.status !== 'ready') return;

        let priority = 1; // Normal priority for today
        let timeLabel = `Pickup: ${order.time}`;
        let isHighPriority = false;

        if (isToday) {
            if (diffMins <= 10) {
                priority = 0; // High priority if pickup is in 10 mins or less today
                isHighPriority = true;
            }
        } else if (isTomorrow) {
            priority = 2; // Lowest priority for tomorrow's orders
            timeLabel = `Tomorrow: ${order.time}`;
        }

        const customerName = stripInsufficientPrefix(customerMap[order.customer_id] || order.customer_id || "");

        allOrders.push({
            id: order.id,
            orderNumber: order.order_number || String(order.id).slice(-4),
            source: 'bookings',
            type: 'preorder',
            status: order.status,
            items: order.items,
            timestamp: new Date(order.created_at),
            pickupTime: pickupDate,
            diffMins: diffMins,
            priority: priority,
            isHighPriority: isHighPriority,
            label: 'PRE-ORDER',
            customer: customerName,
            customer_id: order.customer_id,
            timeLabel: timeLabel,
            insufficient: isInsufficient,
            insufficient_amount: getKitchenRemainingAmount(order),
            insufficient_notes: order.insufficient_notes || "",
            currently_preparing: order.currently_preparing === true
        });
    });

    // Sort: Global sort prioritizing Preparing status first, then Priority, then Timestamp (FIFO)
    allOrders.sort((a, b) => {
        const statusA = getStatusKey(a);
        const statusB = getStatusKey(b);
        
        // Priority to 'Preparing' status overall
        if (statusA === 'preparing' && statusB !== 'preparing') return -1;
        if (statusA !== 'preparing' && statusB === 'preparing') return 1;

        // Within 'Preparing' or 'Pending', follow FIFO based on timestamp
        // but respect the 'priority' (0 for walk-ins, 1 for pre-orders) for Pending
        if (statusA === 'pending' && statusB === 'pending') {
            if (a.priority !== b.priority) return a.priority - b.priority;
        }
        
        // Final fallback: FIFO based on placement time
        return a.timestamp - b.timestamp;
    });

    let counts = { pending: 0, preparing: 0, ready: 0 };
    const panelCounters = { pending: 0, preparing: 0, ready: 0 };
    let preparingIndex = 0;

    allOrders.forEach(order => {
        const statusKey = getStatusKey(order);
        let prepStage = "";
        if (statusKey === "preparing") {
            // Priority given to manual 'currently_preparing' flag
            if (order.currently_preparing) {
                prepStage = "prep-current";
            } else {
                // If not manually marked, use queue positions
                prepStage = (preparingIndex === 0 && !allOrders.some(o => getStatusKey(o.status) === 'preparing' && o.currently_preparing)) 
                    ? "prep-next" 
                    : "prep-queue";
                preparingIndex += 1;
            }
        }
        const card = createKitchenCard(order, panelCounters[statusKey]++, prepStage);
        if (statusKey === 'pending') {
            colPending.appendChild(card);
            counts.pending++;
        } else if (statusKey === 'preparing') {
            colPreparing.appendChild(card);
            counts.preparing++;
        } else if (statusKey === 'ready') {
            colReady.appendChild(card);
            counts.ready++;
        }
    });

    document.getElementById("count-pending").textContent = counts.pending;
    document.getElementById("count-preparing").textContent = counts.preparing;
    document.getElementById("count-ready").textContent = counts.ready;
}

function getDrinkTag(name, temperature) {
    const temp = String(temperature || "").toLowerCase();
    if (temp === "hot") return `<span class="drink-tag drink-hot">HOT</span>`;
    if (temp === "cold" || temp === "iced") return `<span class="drink-tag drink-iced">ICED</span>`;
    const text = String(name || "").toLowerCase();
    if (text.includes("hot")) return `<span class="drink-tag drink-hot">HOT</span>`;
    if (text.includes("cold") || text.includes("iced")) return `<span class="drink-tag drink-iced">ICED</span>`;
    return "";
}

function createKitchenCard(order, panelIndex = 0, prepStage = "") {
    const div = document.createElement("div");
    const statusKey = getStatusKey(order);
    const colorClass = `panel-color-${(Number(panelIndex) % PANEL_COLOR_COUNT) + 1}`;
    div.className = `kitchen-card status-${statusKey} ${order.isHighPriority ? 'priority-high' : 'priority-normal'} ${colorClass} ${prepStage}`;
    
    // Double click/tap logic
    let lastTap = 0;
    div.addEventListener('click', function(e) {
        const now = new Date().getTime();
        const timesince = now - lastTap;
        if ((timesince < 300) && (timesince > 0)) {
            // Double tap detected
            handleOrderTransition(order);
        }
        lastTap = now;
    });

    let itemsHtml = "";
    try {
        const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        if (Array.isArray(items)) {
            itemsHtml = items
            .filter(i => !shouldSuppressKitchenLine(i && (i.name || i.item || i.title || i.label)))
            .map(i => {
                const qty = i.qty || i.quantity || 1;
                const name = i.name || "";
                const tag = getDrinkTag(name, i.temperature || i.temp);
                return `<div class="order-item">${qty}x ${name}${tag ? " " + tag : ""}</div>`;
            }).join("");
        } else if (typeof order.items === 'string') {
            itemsHtml = order.items
            .split(",")
            .map(i => i.trim())
            .filter(i => i && !shouldSuppressKitchenLine(i))
            .map(i => `<div class="order-item">${i}</div>`)
            .join("");
        }
    } catch (e) {
        itemsHtml = `<div>${order.items}</div>`;
    }

    const timeStr = order.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeDisplay = order.type === 'preorder' 
        ? `<span class="${order.isHighPriority ? 'time-warning' : ''}">${order.timeLabel}</span>` 
        : `Ordered: ${timeStr}`;

    const insuffBadge = order.insufficient 
        ? `<span class="insuff-badge" title="Still need \u20B1${Number(order.insufficient_amount||0).toFixed(2)}">INSUFFICIENT (\u20B1${Number(order.insufficient_amount||0).toFixed(2)})</span>` 
        : '';
    const insAmtTag = order.insufficient ? `<span class="insamt-tag" title="Insufficient Amount">InsAmt</span>` : '';
    const paidBadge = (!order.insufficient && /paid/i.test(order.insufficient_notes || order.notes || "")) 
        ? `<span class="paid-badge">PAID</span>` 
        : '';

    const statusLabel = statusKey === 'pending' ? 'Pending' : statusKey === 'preparing' ? 'Preparing' : 'Ready';
    const prepLabel = prepStage === "prep-current" ? "Currently Preparing" : (prepStage === "prep-next" ? "Next" : (prepStage === "prep-queue" ? "On Queue" : ""));
    const prepPill = prepLabel ? `<span class="prep-pill ${prepStage}">${prepLabel}</span>` : "";
    
    // Add "Pause/Resume" button if in Preparing column
    let actionBtn = "";
    if (statusKey === "preparing") {
        const btnText = order.currently_preparing ? "Pause" : "Resume";
        const btnClass = order.currently_preparing ? "btn-pause" : "btn-resume";
        actionBtn = `<button class="prep-action-btn ${btnClass}" onclick="event.stopPropagation(); toggleCurrentlyPreparing('${order.id}', '${order.source}', ${order.currently_preparing})">${btnText}</button>`;
    }

    div.innerHTML = `
        <div class="card-header">
            <div style="display:flex; align-items:center; gap:6px;">
                <span class="order-type">${order.label}</span>
                <span class="status-pill status-${statusKey}">${statusLabel}</span>
                ${prepPill}
            </div>
            <div style="display: flex; align-items: center; justify-content: flex-end; flex: 1;">
                ${actionBtn}
                ${insuffBadge}
                ${insAmtTag}
                ${paidBadge}
                <span class="panel-id" title="Order ID: ${String(order.id)}">#${order.orderNumber}</span>
            </div>
        </div>
        <div class="order-items">
            ${itemsHtml}
        </div>
        <div class="card-footer">
            <span class="customer-name" style="font-size: 1rem; color: var(--coffee-dark); font-weight: 800;">${order.customer || ""}</span>
            <span class="order-time">${timeDisplay}</span>
        </div>
    `;

    return div;
}

async function toggleCurrentlyPreparing(orderId, source, currentVal) {
    try {
        const { error } = await db
            .from(source)
            .update({ currently_preparing: !currentVal })
            .eq("id", orderId);

        if (error) throw error;
        refreshDashboard();
    } catch (err) {
        console.error("Error toggling currently preparing status:", err);
        showMessage("Failed to update status", "error");
    }
}

async function handleOrderTransition(order) {
    const statusKey = getStatusKey(order);
    let newStatus = 'preparing';
    let updatePayload = {};

    if (statusKey === 'ready') {
        newStatus = 'completed';
    } else if (statusKey === 'preparing') {
        newStatus = 'ready';
        updatePayload.currently_preparing = false; // Reset when moving to Ready
    } else if (statusKey === 'pending') {
        newStatus = 'preparing';
    }
    
    updatePayload.status = newStatus;

    try {
        // Use global db instance
        const database = window.db || getDB();
        
        // 1. Update the original table status
        const { error } = await database
            .from(order.source)
            .update(updatePayload)
            .eq("id", order.id);

        if (error) throw error;

        // 2. If completing an order, ensure it's recorded in Sales and history
        if (newStatus === 'completed') {
            console.log("[Kitchen] Order completed, processing sales and history...");
            
            // For Pre-orders (source: 'bookings'), we need to record sale, items and award points
            if (order.source === 'bookings') {
                await recordPreorderCompletion(order);
            } else if (order.insufficient) {
                // For insufficient walk-ins, we already had some logic, let's keep it robust
                await recordInsufficientWalkinCompletion(order);
            }
        }

        if (newStatus === 'completed') {
            showMessage("Order Completed", "success");
        } else {
            showMessage(`Moved to ${newStatus}`, "info");
        }
        
        refreshDashboard();
    } catch (err) {
        console.error("Error transitioning order:", err);
        showMessage("Failed to update order", "error");
    }
}

/** 
 * Handles recording sales, order history, and awarding loyalty points 
 * for completed pre-orders (bookings table).
 */
async function recordPreorderCompletion(order) {
    try {
        const database = window.db || getDB();
        
        // Fetch full booking details
        const { data: booking, error: fetchError } = await database
            .from("bookings")
            .select("*")
            .eq("id", order.id)
            .single();
            
        if (fetchError || !booking) return;

        // 1. Check if already in sales
        const { data: existingSales } = await database
            .from("sales")
            .select("id")
            .eq("booking_id", order.id);
            
        if (!existingSales || existingSales.length === 0) {
            // Record in Sales
            let items = booking.items;
            if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch(e) { items = []; }
            }
            items = Array.isArray(items) ? items : [];

            // Calculate actual paid amount for insufficient payment orders
            const totalOrderAmount = Number(booking.total || 0);
            const amountNeeded = Math.max(Number(booking.insufficient_amount_needed || 0), parseInsufficientAmountFromNotes(booking));
            const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded);

            const salesPayload = {
                customer_id: booking.customer_id,
                items: JSON.stringify(items),
                total: actualPaidAmount,
                amount: actualPaidAmount,
                sale_date: new Date().toISOString(),
                payment_method: booking.payment_method || 'cash',
                status: 'completed',
                type: 'preorder',
                booking_id: booking.id,
                insufficient_payment: booking.insufficient_payment === true || amountNeeded > 0,
                total_order_amount: totalOrderAmount,
                amount_due: amountNeeded
            };
            
            await database.from("sales").insert(salesPayload);
            console.log("[Kitchen] Pre-order Sales Record Created");

            // 2. Record in Orders History (for customer tracking)
            const ordersPayload = items.map(i => ({
                customer_id: String(booking.customer_id || "preorder"),
                product_id: i.id || i.product_id || "",
                name: i.name || "Unknown",
                quantity: Number(i.quantity || i.qty || 1),
                price: Number(i.price || 0) || (Number(i.amount || 0) / Number(i.quantity || i.qty || 1)) || 0,
                category_id: i.category_id || null,
                timestamp: new Date().toISOString(),
                payment_method: booking.payment_method || 'cash',
                status: 'completed'
            }));
            
            if (ordersPayload.length > 0) {
                await database.from("orders").insert(ordersPayload);
            }

            // 3. Award Points
            if (booking.customer_id) {
                const { data: cust } = await database.from("customers")
                    .select("id, loyalty_points, loyalty_card")
                    .or(`email.eq.${booking.customer_id},contact.eq.${booking.customer_id}`)
                    .maybeSingle();
                
                if (cust) {
                    const points = 1; // 1 point per completed pre-order
                    const newPoints = (cust.loyalty_points || 0) + points;
                    await database.from("customers").update({ loyalty_points: newPoints }).eq("id", cust.id);
                    await database.from("loyalty_history").insert({
                        customer_id: cust.id,
                        loyalty_card: cust.loyalty_card,
                        points: points,
                        source: "preorder",
                        order_id: booking.id,
                        total: totalOrderAmount,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    } catch (err) {
        console.error("[Kitchen] Error in recordPreorderCompletion:", err);
    }
}

/** Handles recording sales for completed insufficient walk-in orders. */
async function recordInsufficientWalkinCompletion(order) {
    try {
        const database = window.db || getDB();
        
        // Fetch full order details
        const { data: fullOrder, error: fetchError } = await database
            .from(order.source)
            .select("*")
            .eq("id", order.id)
            .single();
            
        if (fetchError || !fullOrder) return;

        // Check if already in sales
        const { data: existingSales } = await database
            .from("sales")
            .select("id")
            .eq("id", order.id); // For walk-ins, sale ID often matches order ID
            
        if (!existingSales || existingSales.length === 0) {
            const totalOrderAmount = Number(fullOrder.total || 0);
            const amountNeeded = Math.max(Number(fullOrder.insufficient_amount_needed || 0), parseInsufficientAmountFromNotes(fullOrder));
            const actualPaidAmount = Math.max(0, totalOrderAmount - amountNeeded);

            const salesPayload = {
                customer_id: fullOrder.customer_id,
                items: typeof fullOrder.items === 'string' ? fullOrder.items : JSON.stringify(fullOrder.items),
                total: actualPaidAmount,
                sale_date: new Date().toISOString(),
                payment_method: fullOrder.payment_method || 'cash',
                status: 'completed',
                type: fullOrder.type || 'walk-in',
                insufficient_payment: true,
                total_order_amount: totalOrderAmount,
                amount_due: amountNeeded
            };
            
            await database.from("sales").insert(salesPayload);
        }
    } catch (err) {
        console.error("[Kitchen] Error in recordInsufficientWalkinCompletion:", err);
    }
}

function subscribeToChanges() {
    db.channel('kitchen-updates')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_orders' }, payload => {
            refreshDashboard();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, payload => {
            refreshDashboard();
        })
        .subscribe();
}

function showMessage(msg, type) {
    const container = document.getElementById("statusMessage");
    if (container) {
        container.innerHTML = `<div class="message ${type}">${msg}</div>`;
        setTimeout(() => (container.innerHTML = ""), 2000);
    }
}

// Initialize when ready
document.addEventListener("DOMContentLoaded", () => {
    const checkDb = () => {
        if (window.dbReady) {
            initializeKitchen();
        } else {
            setTimeout(checkDb, 100);
        }
    };
    checkDb();
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            refreshDashboard();
        }
    });
});
