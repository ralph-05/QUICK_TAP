// Analytics JS Loaded - Supabase Ready
console.log("[v0] admin-analytics.js loaded - Supabase version")

function getDB() {
  return window.db
}
const categoryMap = { 1: "Coffee", 2: "Non-coffee", 3: "Frappe", 4: "Soda", 5: "Pastries" }
let isDashboardRunning = false
let lastUpdateTime = 0
const MIN_UPDATE_INTERVAL = 2000 // Prevent updates more frequent than 2 seconds
let analyticsUpdateTimer = null

function getWeekKey(d) {
  const t = new Date(d.getTime())
  const day = (d.getDay() + 6) % 7
  t.setDate(d.getDate() - day + 3)
  const first = new Date(t.getFullYear(), 0, 4)
  const week = 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7)
  return t.getFullYear() + "-W" + String(week).padStart(2, "0")
}

function getQuarterKey(d) {
  const y = d.getFullYear()
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${y}-Q${q}`
}

function getSemiAnnualKey(d) {
  const y = d.getFullYear()
  const h = Math.floor(d.getMonth() / 6) + 1
  return `${y}-H${h}`
}

function getAnnualKey(d) {
  return String(d.getFullYear())
}

function calculateDateRange(interval) {
  const end = new Date()
  let start = new Date()
  
  switch (interval) {
      case "day":
          start.setDate(end.getDate() - 7)
          break
      case "week":
          start.setDate(end.getDate() - (8 * 7))
          break
      case "month":
          start.setMonth(end.getMonth() - 6)
          break
      case "quarter":
          start.setMonth(end.getMonth() - (4 * 3))
          break
      case "semiannual":
           start.setMonth(end.getMonth() - (4 * 6))
           break
      case "annual":
          start.setFullYear(end.getFullYear() - 5)
          break
      default:
          start.setDate(end.getDate() - 30)
  }

  const formatDate = (d) => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const da = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${da}`
  }
  
  return { start: formatDate(start), end: formatDate(end) }
}

function formatDateYMD(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${da}`
}

async function loadSales(startArg, endArg) {
  const interval = document.getElementById("anInterval")?.value || "week"
  const sourceSel = document.getElementById("anSource")?.value || "all"
  
  let start = startArg
  let end = endArg
  if (!start || !end) {
      const range = calculateDateRange(interval)
      start = range.start
      end = range.end
  }

  const dailyTotals = {}
  let totalQty = 0
  let totalSales = 0
  const salesBookingIds = new Set()

  function toDateStrFromAny(d) {
    let ts = null
    // Prioritize transaction date (sale_date, timestamp, created_at) over booked date
    if (d.sale_date) {
        ts = new Date(d.sale_date)
    } else if (d.timestamp) {
        ts = new Date(d.timestamp)
    } else if (d.created_at) {
        ts = new Date(d.created_at)
    } else if (d.datetime) {
        ts = new Date(d.datetime)
    } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
        // Fallback to booked date if no transaction timestamp exists
        ts = new Date(d.date + "T00:00:00")
    }

    if (!ts || isNaN(ts.getTime())) ts = new Date()
    const y = ts.getFullYear()
    const m = String(ts.getMonth() + 1).padStart(2, "0")
    const da = String(ts.getDate()).padStart(2, "0")
    return { ts, dateStr: `${y}-${m}-${da}` }
  }

  if (sourceSel === "all" || sourceSel === "sales") {
    const { data: salesData, error } = await getDB().from("sales").select("*")
    if (!error && salesData) {
        salesData.forEach((data) => {
          if (data.booking_id) salesBookingIds.add(String(data.booking_id))
          const { ts, dateStr } = toDateStrFromAny(data)
          if (start && dateStr < start) return
          if (end && dateStr > end) return
          const total = Number(data.total || 0)
          let items = data.items
          if (typeof items === 'string') {
              try { items = JSON.parse(items) } catch(e) { items = [] }
          }
          items = Array.isArray(items) ? items : []
          const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
          let key = dateStr
          if (interval === "week") key = getWeekKey(ts)
          else if (interval === "month") key = ts.getFullYear() + "-" + String(ts.getMonth() + 1).padStart(2, "0")
          else if (interval === "quarter") key = getQuarterKey(ts)
          else if (interval === "semiannual") key = getSemiAnnualKey(ts)
          else if (interval === "annual") key = getAnnualKey(ts)
          if (!dailyTotals[key]) dailyTotals[key] = 0
          dailyTotals[key] += total
          totalSales += total
          totalQty += qty
        })
    }
  }

  // Point 6: Include pre-orders from bookings table if not already in sales
  if (sourceSel === "all") {
    const { data: bookingsData, error } = await getDB().from("bookings").select("*").eq("type", "preorder")
    if (!error && bookingsData) {
        bookingsData.forEach((d) => {
          // Avoid double counting if already completed and in sales
          if (salesBookingIds.has(String(d.id))) return
          // Only include active/valid pre-orders (pending, accepted, etc.)
          if (['rejected', 'cancelled'].includes(d.status)) return

          const { ts, dateStr } = toDateStrFromAny(d)
          if (start && dateStr < start) return
          if (end && dateStr > end) return

          let items = d.items
          if (typeof items === 'string') {
              try { items = JSON.parse(items) } catch(e) { items = [] }
          }
          items = Array.isArray(items) ? items : []
          
          let total = Number(d.total || 0)
          if (total === 0 && items.length > 0) {
              total = items.reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || i.quantity || 1)), 0)
          }
          
          const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
          
          let key = dateStr
          if (interval === "week") key = getWeekKey(ts)
          else if (interval === "month") key = ts.getFullYear() + "-" + String(ts.getMonth() + 1).padStart(2, "0")
          else if (interval === "quarter") key = getQuarterKey(ts)
          else if (interval === "semiannual") key = getSemiAnnualKey(ts)
          else if (interval === "annual") key = getAnnualKey(ts)
          
          if (!dailyTotals[key]) dailyTotals[key] = 0
          dailyTotals[key] += total
          totalSales += total
          totalQty += qty
        })
    }
  }
  
  return { dailyTotals, totalQty, totalSales }
}

async function loadDailySales() {
  const { data: salesData, error: salesError } = await getDB().from("sales").select("*")
  const dailyTotals = {}
  const weeklyTotals = {}
  const weeklyBreakdown = {}
  let totalQty = 0
  let totalSales = 0
  const salesBookingIds = new Set()

  function toTsAndDate(d) {
    let ts = null
    // Prioritize transaction date over booked date
    if (d.sale_date) {
        ts = new Date(d.sale_date)
    } else if (d.timestamp) {
        ts = new Date(d.timestamp)
    } else if (d.created_at) {
        ts = new Date(d.created_at)
    } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
        ts = new Date(d.date + "T00:00:00")
    }
    if (!ts || isNaN(ts.getTime())) ts = new Date()
    const y = ts.getFullYear()
    const m = String(ts.getMonth() + 1).padStart(2, "0")
    const da = String(ts.getDate()).padStart(2, "0")
    return { ts, dateStr: `${y}-${m}-${da}` }
  }

  if (!salesError && salesData) {
      salesData.forEach((d) => {
        if (d.booking_id) salesBookingIds.add(String(d.booking_id))
        const { ts, dateStr } = toTsAndDate(d)
        
        let items = d.items
        if (typeof items === 'string') {
            try { items = JSON.parse(items) } catch(e) { items = [] }
        }
        items = Array.isArray(items) ? items : []

        const total =
          Number(d.total || 0) || Number(d.amount || 0) || items.reduce((s, i) => s + Number(i.amount || 0), 0)
        const qty = items.reduce((s, i) => s + Number(i.quantity || 0), 0)
        
        dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + total
        const wk = getWeekKey(ts)
        weeklyTotals[wk] = (weeklyTotals[wk] || 0) + total
        const di = (ts.getDay() + 6) % 7
        if (!weeklyBreakdown[wk]) weeklyBreakdown[wk] = [0, 0, 0, 0, 0, 0, 0]
        weeklyBreakdown[wk][di] += total
        totalSales += total
        totalQty += qty
      })
  }

  // NOTE: We no longer include 'pending_orders' or 'bookings' table here because 
  // they are already represented in 'sales' when completed.
  
  return { dailyTotals, weeklyTotals, weeklyBreakdown, totalQty, totalSales }
}

let descChartInstance = null
function createDescriptiveChart(labels, values, type, titleText) {
  if (descChartInstance) {
    descChartInstance.destroy()
    descChartInstance = null
  }
  const sorted = (labels || []).slice().sort()
  const map = new Map(labels.map((l, i) => [l, values[i]]))
  const sortedVals = sorted.map((l) => map.get(l) || 0)

  const canvas = document.getElementById("analyticsDescriptiveChart")
  if (!canvas) return

  const parent = canvas.parentNode
  const freshCanvas = document.createElement('canvas')
  freshCanvas.id = canvas.id
  freshCanvas.className = canvas.className
  freshCanvas.style.width = "100%"
  freshCanvas.style.height = "100%"
  freshCanvas.style.maxHeight = "none"
  
  parent.replaceChild(freshCanvas, canvas)
  
  descChartInstance = new window.Chart(freshCanvas, {
    type: "line",
    data: {
      labels: sorted,
      datasets: [
        {
          label: "Sales (₱)",
          data: sortedVals,
          backgroundColor: "transparent",
          borderColor: "#0078d4",
          borderWidth: 2,
          tension: 0.25,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        title: { display: true, text: titleText || "Sales Trend" },
        legend: { position: "top" },
        tooltip: {
          callbacks: { label: (ctx) => ctx.dataset.label + ": ₱" + Number(ctx.parsed.y || ctx.parsed).toFixed(2) },
        },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => "₱" + v } } },
    },
  })
}

function generateForecast(values, count = 7) {
  const n = values.length
  if (n === 0) return []
  if (n === 1) {
      const val = values[0]
      return new Array(count).fill(val)
  }
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += values[i]
    sumXY += i * values[i]
    sumX2 += i * i
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n
  const forecast = []
  for (let i = n; i < n + count; i++) {
    let val = Math.round(slope * i + intercept)
    if (val < 0) val = 0
    forecast.push(val)
  }
  return forecast
}

let predChartInstance = null
function createForecastChart(pastLabels, pastValues, interval) {
  if (predChartInstance) {
      predChartInstance.destroy()
      predChartInstance = null
  }
  
  // Determine forecast count and title based on interval
  let forecastCount = 7
  let titleText = "Next 7 Days Forecast"
  let legendLabel = "Forecast"

  if (interval === "day") {
      forecastCount = 7
      titleText = "Daily Forecast"
      legendLabel = "Daily Forecast"
  } else if (interval === "week") {
      forecastCount = 1
      titleText = "7 Day Forecast"
      legendLabel = "7 Day Forecast"
  } else if (interval === "month") {
      forecastCount = 1
      titleText = "30 Day Forecast"
      legendLabel = "30 Day Forecast"
  } else if (interval === "quarter") {
      forecastCount = 1
      titleText = "Quarterly Forecast"
      legendLabel = "Quarterly Forecast"
  } else if (interval === "semiannual") {
      forecastCount = 1
      titleText = "Semi-Annual Forecast"
      legendLabel = "Semi-Annual Forecast"
  } else if (interval === "annual") {
      forecastCount = 1
      titleText = "Annual Forecast"
      legendLabel = "Annual Forecast"
  }

  // Update title in DOM
  const titleEl = document.getElementById("forecastTitle")
  if (titleEl) titleEl.innerText = titleText

  const sorted = (pastLabels || []).slice().sort()
  const map = new Map(pastLabels.map((l, i) => [l, pastValues[i]]))
  const sortedVals = sorted.map((l) => map.get(l) || 0)
  const forecast = generateForecast(sortedVals, forecastCount)
  const lastDateStr = sorted[sorted.length - 1]
  let startDate = lastDateStr ? new Date(lastDateStr + "T00:00:00") : new Date()
  
  if (lastDateStr) {
      if (interval === "month" && lastDateStr.length === 7) {
          startDate = new Date(lastDateStr + "-01T00:00:00")
      } else if (interval === "week") {
          const parts = lastDateStr.split("-W")
          if (parts.length === 2) {
              const y = parseInt(parts[0])
              const w = parseInt(parts[1])
              const d = new Date(y, 0, 4) // Jan 4 is always in week 1
              const day = (d.getDay() + 6) % 7 // Mon=0
              d.setDate(d.getDate() - day + (w - 1) * 7)
              startDate = d
          }
      } else if (interval === "quarter") {
          const parts = lastDateStr.split("-Q")
          if (parts.length === 2) {
             const y = parseInt(parts[0])
             const q = parseInt(parts[1])
             const m = (q - 1) * 3
             startDate = new Date(y, m, 1)
          }
      } else if (interval === "semiannual") {
          const parts = lastDateStr.split("-H")
          if (parts.length === 2) {
             const y = parseInt(parts[0])
             const h = parseInt(parts[1])
             const m = (h - 1) * 6
             startDate = new Date(y, m, 1)
          }
      } else if (interval === "annual") {
          startDate = new Date(lastDateStr + "-01-01T00:00:00")
      }
  }

  const futureLabels = []
  for (let i = 1; i <= forecast.length; i++) {
    let label = ""
    if (interval === "month") {
        const d = new Date(startDate)
        d.setMonth(d.getMonth() + i)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        label = `${y}-${m}`
    } else if (interval === "quarter") {
        const d = new Date(startDate)
        d.setMonth(d.getMonth() + i * 3)
        const y = d.getFullYear()
        const q = Math.floor(d.getMonth() / 3) + 1
        label = `${y}-Q${q}`
    } else if (interval === "semiannual") {
        const d = new Date(startDate)
        d.setMonth(d.getMonth() + i * 6)
        const y = d.getFullYear()
        const h = Math.floor(d.getMonth() / 6) + 1
        label = `${y}-H${h}`
    } else if (interval === "annual") {
        const d = new Date(startDate)
        d.setFullYear(d.getFullYear() + i)
        label = String(d.getFullYear())
    } else if (interval === "week") {
        const d = new Date(startDate.getTime() + i * 7 * 86400000)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, "0")
        const da = String(d.getDate()).padStart(2, "0")
        label = `${y}-${m}-${da}`
    } else {
        const d = new Date(startDate.getTime() + i * 86400000)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, "0")
        const da = String(d.getDate()).padStart(2, "0")
        label = `${y}-${m}-${da}`
    }
    futureLabels.push(label)
  }

  const canvas = document.getElementById("analyticsPredictiveChart")
  if (!canvas) return
  
  const parent = canvas.parentNode
  const freshCanvas = document.createElement('canvas')
  freshCanvas.id = canvas.id
  freshCanvas.className = canvas.className
  freshCanvas.style.height = "100%"
  freshCanvas.style.width = "100%"
  freshCanvas.style.maxHeight = "none"
  
  parent.replaceChild(freshCanvas, canvas)

  predChartInstance = new window.Chart(freshCanvas, {
    type: "line",
    data: {
      labels: [...sorted, ...futureLabels],
      datasets: [
        {
          label: "Actual (₱)",
          data: [...sortedVals, ...new Array(forecast.length).fill(null)],
          backgroundColor: "transparent",
          borderColor: "#0078d4",
          borderWidth: 2,
          tension: 0.25,
        },
        {
          label: legendLabel,
          data: [...new Array(sortedVals.length).fill(null), ...forecast],
          borderColor: "#f8c12b",
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        title: { display: true, text: "Sales Forecast" },
        legend: { position: "top" },
        tooltip: { callbacks: { label: (ctx) => "₱" + Number(ctx.parsed.y || ctx.parsed).toFixed(2) } },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => "₱" + v } } },
    },
  })
}

async function loadCategoryTotals(startArg, endArg) {
  const productCats = {} // Map docId -> catId
  const productCatsByName = {} // Map name -> catId
  try {
      const { data: productData, error } = await getDB().from("products").select("*")
      if (productData) {
          productData.forEach(d => {
              const catId = d.category_id
              if (catId) {
                  productCats[d.id] = catId
                  if (d.id) {
                      productCats[d.id] = catId
                      productCats[String(d.id)] = catId
                  }
                  if (d.name) {
                      productCatsByName[d.name.trim().toLowerCase()] = catId
                  }
              }
          })
          console.log(`[v0] Loaded ${Object.keys(productCats).length} products for category mapping`)
      }
  } catch (e) {
      console.error("[v0] Error loading products for mapping:", e)
  }

  const interval = document.getElementById("anInterval")?.value || "week"
  
  let start = startArg
  let end = endArg
  if (!start || !end) {
      const range = calculateDateRange(interval)
      start = document.getElementById("anStart")?.value || range.start
      end = document.getElementById("anEnd")?.value || range.end
  }
  
  console.log(`[v0] loadCategoryTotals: interval=${interval}, range=${start} to ${end}`)

  const mode = document.getElementById("catMode")?.value || "amount"
  const sourceSel = document.getElementById("anSource")?.value || "all"
  const totals = {}
  const salesBookingIds = new Set()

  function getLocalYMD(d) {
    let ts = null
    // Prioritize transaction date over booked date
    if (d.sale_date) {
        ts = new Date(d.sale_date)
    } else if (d.timestamp) {
        ts = new Date(d.timestamp)
    } else if (d.created_at) {
        ts = new Date(d.created_at)
    } else if (d.datetime) {
        ts = new Date(d.datetime)
    } else if (d.date && typeof d.date === "string" && d.date.includes("-")) {
        ts = new Date(d.date + "T00:00:00")
    } else if (d.Date) {
        ts = new Date(String(d.Date) + "T00:00:00")
    }

    if (!ts || isNaN(ts.getTime())) ts = new Date()
    const y = ts.getFullYear()
    const m = String(ts.getMonth() + 1).padStart(2, "0")
    const da = String(ts.getDate()).padStart(2, "0")
    return `${y}-${m}-${da}`
  }

  if (sourceSel === "all" || sourceSel === "sales") {
    const { data: salesData, error } = await getDB().from("sales").select("*")
    if (salesData) {
        salesData.forEach((d) => {
          if (d.booking_id) salesBookingIds.add(String(d.booking_id))
          const dateStr = getLocalYMD(d)
          if (start && dateStr < start) return;
          if (end && dateStr > end) return;
          
          let items = d.items || [];
          if (typeof items === 'string') {
             try { items = JSON.parse(items); } catch(e) { items = []; }
          }
          if (!items.length) {
              if (d.total > 0) {
                  const name = "Uncategorized";
                  if (!totals[name]) totals[name] = 0;
                  if (mode === "amount") totals[name] += Number(d.total);
              }
          }

          items.forEach((it) => {
            let catId = it.category_id || it.categoryId
            if (!catId && it.id) catId = productCats[it.id]
            if (!catId && it.name) catId = productCatsByName[String(it.name).trim().toLowerCase()]
            
            // Heuristic Fallback
            if (!catId && it.name) {
                const lowerName = String(it.name).toLowerCase()
                for (const [id, label] of Object.entries(categoryMap)) {
                     if (lowerName.includes(label.toLowerCase())) { catId = id; break; }
                }
            }
            
            catId = Number(catId)
            let name = categoryMap[catId] || (catId ? "Category " + catId : "Uncategorized")
            
            if (!totals[name]) totals[name] = 0
            if (mode === "quantity") {
                totals[name] += Number(it.quantity || it.qty || 0);
            } else {
                let amt = Number(it.amount);
                if (isNaN(amt) || amt === 0) amt = Number(it.price || 0) * Number(it.quantity || it.qty || 0);
                totals[name] += amt;
            }
          })
        })
    }

    // Point 6: Include pre-orders from bookings table if not already in sales
    if (sourceSel === "all") {
      const { data: bookingsData } = await getDB().from("bookings").select("*").eq("type", "preorder")
      if (bookingsData) {
          bookingsData.forEach((d) => {
            if (salesBookingIds.has(String(d.id))) return
            if (['rejected', 'cancelled'].includes(d.status)) return
            
            const dateStr = getLocalYMD(d)
            if (start && dateStr < start) return;
            if (end && dateStr > end) return;
            
            let items = d.items || []
            if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }
            
            items.forEach((it) => {
              let catId = it.category_id || it.categoryId
              if (!catId && it.id) catId = productCats[it.id]
              
              catId = Number(catId)
              let name = categoryMap[catId] || (catId ? "Category " + catId : "Uncategorized")
              
              if (!totals[name]) totals[name] = 0
              if (mode === "quantity") {
                  totals[name] += Number(it.quantity || it.qty || 1);
              } else {
                  const amt = Number(it.price || 0) * Number(it.qty || it.quantity || 1);
                  totals[name] += amt;
              }
            })
          })
      }
    }
  }

  if (sourceSel === "all" || sourceSel === "orders") {
    const { data: ordersData } = await getDB().from("orders").select("*")
    if (ordersData) {
        let processedCount = 0
        let skippedCount = 0
        
        ordersData.forEach((d) => {
          // Prevent double counting if already in sales table
          if (d.booking_id && salesBookingIds.has(String(d.booking_id))) return

          const dateStr = getLocalYMD(d)
          if (start && dateStr < start) { skippedCount++; return; }
          if (end && dateStr > end) { skippedCount++; return; }
          
          processedCount++;
          let catId = d.category_id || d.categoryId
          if (!catId && d.id) catId = productCats[d.id]
          if (!catId && d.name) catId = productCatsByName[String(d.name).trim().toLowerCase()]

          // Heuristic Fallback for Orders
          if (!catId && d.name) {
               const lowerName = String(d.name).toLowerCase()
               for (const [id, label] of Object.entries(categoryMap)) {
                    if (lowerName.includes(label.toLowerCase())) {
                        catId = id
                        break
                    }
               }
               if (!catId) {
                   if (lowerName.includes("latte") || lowerName.includes("americano") || lowerName.includes("cappuccino") || lowerName.includes("espresso") || lowerName.includes("mocha") || lowerName.includes("macchiato") || lowerName.includes("brew")) catId = 1
                   else if (lowerName.includes("chocolate") || lowerName.includes("matcha") || lowerName.includes("tea") || lowerName.includes("milk") || lowerName.includes("juice")) catId = 2
                   else if (lowerName.includes("frappe") || lowerName.includes("shake") || lowerName.includes("blend")) catId = 3
                   else if (lowerName.includes("soda") || lowerName.includes("coke") || lowerName.includes("sprite") || lowerName.includes("royal") || lowerName.includes("soft drink")) catId = 4
                   else if (lowerName.includes("croissant") || lowerName.includes("waffle") || lowerName.includes("cake") || lowerName.includes("cookie") || lowerName.includes("bread") || lowerName.includes("toast") || lowerName.includes("sandwich") || lowerName.includes("pastry")) catId = 5
               }
          }

          catId = Number(catId)
          let name = categoryMap[catId]
          if (!name && catId) name = "Category " + catId
          if (!name) name = "Uncategorized"
          
          if (!totals[name]) totals[name] = 0
          if (mode === "quantity") {
              const qty = Number(d.quantity);
              totals[name] += isNaN(qty) ? 0 : qty;
          } else {
              const p = Number(d.price);
              const q = Number(d.quantity);
              const amt = (!isNaN(p) && !isNaN(q)) ? p * q : 0;
              totals[name] += amt;
          }
        })
    }
  }

  // NOTE: We no longer include 'orders' or 'pending_orders' tables here because 
  // they are already represented in 'sales' when completed.
  
  console.log("[v0] Category Totals computed:", totals);
  return totals
}

let categoryChartInstance = null
function createCategoryPieChart(labels, values, titlePrefix = "Sales by Category", titleSuffix = "") {
  console.log("[v0] createCategoryPieChart called with:", { labels, values, titlePrefix, titleSuffix })
  const canvas = document.getElementById("analyticsCategoryChart")
  if (!canvas) return

  if (categoryChartInstance) {
    categoryChartInstance.destroy()
    categoryChartInstance = null
  }

  const total = values.reduce((a, b) => a + b, 0)
  
  if (total === 0) {
      categoryChartInstance = new window.Chart(canvas, {
        type: "pie",
        data: {
          labels: ["No Data"],
          datasets: [{
            data: [1],
            backgroundColor: ["#e0e0e0"]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom" },
            title: { display: true, text: titlePrefix + " (No Data)" + titleSuffix },
            tooltip: { enabled: false }
          }
        }
      });
      return;
  }

  const pctLabels = labels.map((l, i) => {
    if (l === "No Data") return l
    return `${l} (${Math.round((values[i] / total) * 100)}%)`
  })
  
  const colorMap = {
    Coffee: "#0078d4",
    "Non-coffee": "#00b7c3",
    Frappe: "#ff6b6b",
    Soda: "#f59e0b",
    Pastries: "#7c3aed",
    "No Data": "#e0e0e0"
  }
  const colors = pctLabels.map((pl) => {
    const base = String(pl).split(" (")[0]
    return colorMap[base] || "#999999"
  })

  categoryChartInstance = new window.Chart(canvas, {
    type: "pie",
    data: {
      labels: pctLabels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        title: {
          display: true,
          text:
            titlePrefix +
            (document.getElementById("catMode")?.value === "quantity"
              ? " (Qty %)"
              : " (Amount %)") + titleSuffix,
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.label === "No Data") return "No Data available"
              const value = Number(ctx.parsed).toFixed(2)
              const pct = Math.round((ctx.parsed / total) * 100)
              return ctx.label + ": ₱" + value + " (" + pct + "%)"
            },
          },
        },
      },
    },
  })
}

async function loadAnalyticsTotals() {
  const sourceSel = document.getElementById("anSource")?.value || "all"
  const interval = document.getElementById("anInterval")?.value || "week"
  const range = calculateDateRange(interval)
  
  let start = document.getElementById("anStart")?.value || range.start
  let end = document.getElementById("anEnd")?.value || range.end
  
  const totals = {}
  let totalSales = 0
  let totalQty = 0

  function addPoint(dateStr, ts, qty, amount) {
    if (!dateStr) return
    if (start && dateStr < start) return
    if (end && dateStr > end) return
    
    let key = dateStr
    if (interval === "week" && ts) key = getWeekKey(ts)
    else if (interval === "month" && ts) key = ts.getFullYear() + "-" + String(ts.getMonth() + 1).padStart(2, "0")
    else if (interval === "quarter" && ts) key = getQuarterKey(ts)
    else if (interval === "semiannual" && ts) key = getSemiAnnualKey(ts)
    else if (interval === "annual" && ts) key = getAnnualKey(ts)
    
    if (!totals[key]) totals[key] = { total: 0, qty: 0 }
    totals[key].total += amount
    totals[key].qty += qty
    totalSales += amount
    totalQty += qty
  }

  if (sourceSel === "sales") {
    const { data: salesData } = await getDB().from("sales").select("*")
    if (salesData) {
      salesData.forEach((d) => {
        let ts = null
        // Prioritize transaction date over booked date
        if (d.sale_date) {
            ts = new Date(d.sale_date)
        } else if (d.timestamp) {
            ts = new Date(d.timestamp)
        } else if (d.created_at) {
            ts = new Date(d.created_at)
        } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
            ts = new Date(d.date + "T00:00:00")
        }
        
        if (!ts || isNaN(ts.getTime())) ts = new Date()
        
        const y = ts.getFullYear()
        const m = String(ts.getMonth() + 1).padStart(2, "0")
        const da = String(ts.getDate()).padStart(2, "0")
        const dateStr = `${y}-${m}-${da}`
        
        let items = d.items || [];
        if (typeof items === 'string') {
             try { items = JSON.parse(items); } catch(e) { items = []; }
        }

        const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
        const amount =
          Number(d.total || 0) || Number(d.amount || 0) ||
          (Array.isArray(items) ? items.reduce((s, i) => s + Number(i.amount || (Number(i.price || 0) * Number(i.quantity || i.qty || 0))), 0) : 0)
        addPoint(dateStr, ts, qty, amount)
      })
    }
  }

  // If "all" is selected, we combine data sources but try to avoid double counting.
  // We prioritize 'sales' table for transaction totals.
  if (sourceSel === "all") {
    const { data: salesData } = await getDB().from("sales").select("*")
    if (salesData) {
      salesData.forEach((d) => {
        let ts = null
        if (d.sale_date) {
            ts = new Date(d.sale_date)
        } else if (d.timestamp) {
            ts = new Date(d.timestamp)
        } else if (d.created_at) {
            ts = new Date(d.created_at)
        } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
            ts = new Date(d.date + "T00:00:00")
        }
        
        if (!ts || isNaN(ts.getTime())) ts = new Date()
        
        const y = ts.getFullYear()
        const m = String(ts.getMonth() + 1).padStart(2, "0")
        const da = String(ts.getDate()).padStart(2, "0")
        const dateStr = `${y}-${m}-${da}`
        
        let items = d.items || [];
        if (typeof items === 'string') {
             try { items = JSON.parse(items); } catch(e) { items = []; }
        }

        const qty = items.reduce((s, i) => s + Number(i.quantity || i.qty || 0), 0)
        const amount =
          Number(d.total || 0) || Number(d.amount || 0) ||
          (Array.isArray(items) ? items.reduce((s, i) => s + Number(i.amount || (Number(i.price || 0) * Number(i.quantity || i.qty || 0))), 0) : 0)
        addPoint(dateStr, ts, qty, amount)
      })
    }

    // Get set of booking IDs already in sales to avoid double counting
    const salesBookingIds = new Set(
        (salesData || [])
          .filter(s => s.booking_id)
          .map(s => String(s.booking_id))
    )

    // NOTE: We no longer include pre-orders from 'orders' table here because 
    // they are already represented in 'bookings' (or 'sales' if completed).
    // Including them from 'orders' causes double-counting since they lack booking_id link.

    // NOTE: We no longer include pre-orders from 'bookings' table here because 
    // they are already represented in 'sales' when completed.
  }

  const labels = Object.keys(totals).sort()
  const values = labels.map((k) => totals[k].total)
  return { labels, values, totalSales, totalQty }
}

function normalizeProductName(name) {
  if (!name) return "Unknown"
  const trimmed = String(name).trim()
  const idx = trimmed.indexOf("(")
  if (idx > 0) return trimmed.substring(0, idx).trim()
  return trimmed
}

async function loadProductAnalyticsTotals(startArg, endArg) {
  const interval = document.getElementById("anInterval")?.value || "week"
  let start = startArg
  let end = endArg
  if (!start || !end) {
    const range = calculateDateRange(interval)
    start = document.getElementById("anStart")?.value || range.start
    end = document.getElementById("anEnd")?.value || range.end
  }

  const [prodRes, salesRes] = await Promise.all([
    getDB().from("products").select("*"),
    getDB().from("sales").select("*"),
  ])

  const prodMap = {}
  ;(prodRes.data || []).forEach((d) => {
    const name = d.name || "Unknown"
    const baseName = normalizeProductName(name)
    prodMap[d.id] = { name, baseName, price: Number(d.price || 0) }
  })

  const totals = {}
  let grandTotal = 0
  let grandQty = 0

  function getDateStr(d) {
    let ts = null
    if (d.sale_date) ts = new Date(d.sale_date)
    else if (d.timestamp) ts = new Date(d.timestamp)
    else if (d.created_at) ts = new Date(d.created_at)
    else if (d.datetime) ts = new Date(d.datetime)
    else if (d.date && typeof d.date === "string" && d.date.includes("-")) ts = new Date(d.date + "T00:00:00")
    if (!ts || isNaN(ts.getTime())) return null
    const y = ts.getFullYear()
    const m = String(ts.getMonth() + 1).padStart(2, "0")
    const da = String(ts.getDate()).padStart(2, "0")
    return `${y}-${m}-${da}`
  }

  ;(salesRes.data || []).forEach((d) => {
    const dateStr = getDateStr(d)
    if (!dateStr) return
    if (start && dateStr < start) return
    if (end && dateStr > end) return

    let items = d.items || []
    if (typeof items === "string") {
      try {
        items = JSON.parse(items)
      } catch (e) {
        items = []
      }
    }
    if (!Array.isArray(items)) items = []

    if (!items.length && d.product_id) {
      items = [
        {
          id: d.product_id,
          name: d.name,
          quantity: d.quantity,
          price: d.price,
          category_id: d.category_id,
        },
      ]
    }

    items.forEach((it) => {
      const qty = Number(it.quantity || it.qty || 0)
      const basePrice = prodMap[it.id]?.price ?? Number(it.price || 0)
      const lineTotal = Number(it.amount) || basePrice * qty
      if (!qty && !lineTotal) return
      const rawName = prodMap[it.id]?.name || it.name || "Unknown"
      const baseName = prodMap[it.id]?.baseName || normalizeProductName(rawName)
      const key = baseName
      const name = baseName
      if (!totals[key]) totals[key] = { name, qty: 0, revenue: 0 }
      totals[key].qty += qty
      totals[key].revenue += lineTotal
      grandQty += qty
      grandTotal += lineTotal
    })
  })

  return { totals, grandTotal, grandQty }
}

let productChartInstance = null
let productTrendChartInstance = null
let productForecastChartInstance = null

async function loadAnalyticsProductFilter() {
  const sel = document.getElementById("anProduct")
  if (!sel) return
  try {
    const res = await getDB().from("products").select("id,name").order("name")
    if (res.error) throw res.error
    sel.innerHTML = ""
    const optAll = document.createElement("option")
    optAll.value = ""
    optAll.textContent = "All Products"
    sel.appendChild(optAll)
    const seen = new Set()
    ;(res.data || []).forEach((p) => {
      const baseName = normalizeProductName(p.name)
      if (!baseName || seen.has(baseName)) return
      seen.add(baseName)
      const opt = document.createElement("option")
      opt.value = baseName
      opt.textContent = baseName
      sel.appendChild(opt)
    })
  } catch (e) {
    console.error("Error loading analytics products:", e)
  }
}

async function loadProductTimeSeries(startArg, endArg, intervalOverride) {
  const sel = document.getElementById("anProduct")
  if (!sel || !sel.value) return null
  const productKey = sel.value
  const interval = intervalOverride || document.getElementById("anInterval")?.value || "week"
  let start = startArg
  let end = endArg
  if (!start || !end) {
    const range = calculateDateRange(interval)
    start = document.getElementById("anStart")?.value || range.start
    end = document.getElementById("anEnd")?.value || range.end
  }

  const { data: salesData } = await getDB().from("sales").select("*")
  if (!salesData || !salesData.length) return null

  const buckets = {}

  salesData.forEach((d) => {
    let ts = null
    if (d.sale_date) ts = new Date(d.sale_date)
    else if (d.timestamp) ts = new Date(d.timestamp)
    else if (d.created_at) ts = new Date(d.created_at)
    else if (d.date && typeof d.date === "string" && d.date.includes("-")) ts = new Date(d.date + "T00:00:00")
    if (!ts || isNaN(ts.getTime())) return

    const y = ts.getFullYear()
    const m = String(ts.getMonth() + 1).padStart(2, "0")
    const da = String(ts.getDate()).padStart(2, "0")
    const dateStr = `${y}-${m}-${da}`
    if (start && dateStr < start) return
    if (end && dateStr > end) return

    let items = d.items || []
    if (typeof items === "string") {
      try {
        items = JSON.parse(items)
      } catch (e) {
        items = []
      }
    }
    if (!Array.isArray(items)) items = []

    if (!items.length && d.product_id) {
      items = [
        {
          id: d.product_id,
          name: d.name,
          quantity: d.quantity,
          amount: d.total || d.amount,
        },
      ]
    }

    if (!items.length) return

    let key = dateStr
    if (interval === "week") key = getWeekKey(ts)
    else if (interval === "month") key = ts.getFullYear() + "-" + String(ts.getMonth() + 1).padStart(2, "0")
    else if (interval === "quarter") key = getQuarterKey(ts)
    else if (interval === "semiannual") key = getSemiAnnualKey(ts)
    else if (interval === "annual") key = getAnnualKey(ts)

    let bucket = buckets[key]
    if (!bucket) {
      bucket = { qty: 0, revenue: 0 }
      buckets[key] = bucket
    }

    items.forEach((it) => {
      const rawName = it.name || d.name || ""
      const baseName = normalizeProductName(rawName)
      if (baseName !== productKey) return
      const qty = Number(it.quantity || it.qty || 0)
      const amount = Number(it.amount || 0)
      if (!qty && !amount) return
      bucket.qty += qty
      bucket.revenue += amount
    })
  })

  const labels = Object.keys(buckets).sort()
  const qtyValues = labels.map((k) => buckets[k].qty)
  const revenueValues = labels.map((k) => buckets[k].revenue)
  return { labels, qtyValues, revenueValues }
}

async function renderProductTrendChart(start, end) {
  const canvas = document.getElementById("analyticsProductTrendChart")
  const emptyEl = document.getElementById("analyticsProductTrendEmpty")
  if (!canvas || !window.Chart) return

  const sel = document.getElementById("anProduct")
  if (!sel || !sel.value) {
    if (emptyEl) {
      emptyEl.textContent =
        "Select a product above to see its daily, weekly, or monthly trend."
      emptyEl.style.display = "flex"
    }
    if (productTrendChartInstance) {
      productTrendChartInstance.destroy()
      productTrendChartInstance = null
    }
    return
  }

  const series = await loadProductTimeSeries(start, end, null)
  if (!series || !series.labels.length) {
    if (emptyEl) {
      emptyEl.textContent = "No data for this product in the selected range."
      emptyEl.style.display = "flex"
    }
    if (productTrendChartInstance) {
      productTrendChartInstance.destroy()
      productTrendChartInstance = null
    }
    return
  }

  if (productTrendChartInstance) {
    productTrendChartInstance.destroy()
    productTrendChartInstance = null
  }

  productTrendChartInstance = new window.Chart(canvas, {
    type: "line",
    data: {
      labels: series.labels,
      datasets: [
        {
          label: "Revenue",
          data: series.revenueValues,
          borderColor: "#d4a574",
          backgroundColor: "rgba(212,165,116,0.2)",
          tension: 0.2,
          yAxisID: "y",
        },
        {
          label: "Qty",
          data: series.qtyValues,
          borderColor: "#4b4b4b",
          backgroundColor: "rgba(75,75,75,0.15)",
          tension: 0.2,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      scales: {
        y: {
          beginAtZero: true,
          position: "left",
          ticks: {
            callback: (v) => "₱" + v,
          },
        },
        y1: {
          beginAtZero: true,
          position: "right",
          grid: { drawOnChartArea: false },
        },
      },
    },
  })
  if (emptyEl) {
    emptyEl.style.display = "none"
  }
}
function renderAnalyticsProductTable(result) {
  const body = document.getElementById("analyticsProductBody")
  const insightsEl = document.getElementById("analyticsProductInsights")
  const canvas = document.getElementById("analyticsProductChart")
  if (insightsEl) insightsEl.textContent = ""
  if (!body) return
  body.innerHTML = ""

  const totals = (result && result.totals) || {}
  const grandTotal = Number((result && result.grandTotal) || 0)

  const items = Object.values(totals).sort((a, b) => b.revenue - a.revenue)
  if (!items.length) {
    const tr = document.createElement("tr")
    tr.innerHTML = '<td colspan="5" style="text-align:center;">No data for selected range</td>'
    body.appendChild(tr)
    if (productChartInstance) {
      productChartInstance.destroy()
      productChartInstance = null
    }
    return
  }

  items.forEach((i) => {
    const avgPrice = i.qty ? i.revenue / i.qty : 0
    const pct = grandTotal ? (i.revenue / grandTotal * 100).toFixed(1) + "%" : "0%"
    const tr = document.createElement("tr")
    tr.innerHTML =
      "<td>" +
      i.name +
      "</td><td>" +
      i.qty +
      "</td><td>₱" +
      avgPrice.toFixed(2) +
      "</td><td>₱" +
      i.revenue.toFixed(2) +
      "</td><td>" +
      pct +
      "</td>"
    body.appendChild(tr)
  })

  if (canvas && window.Chart) {
    if (productChartInstance) {
      productChartInstance.destroy()
      productChartInstance = null
    }
    const topItems = items.slice(0, 10)
    const labels = topItems.map((i) => i.name)
    const values = topItems.map((i) => Number(i.revenue || 0))
    productChartInstance = new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue",
            data: values,
            backgroundColor: "transparent",
            borderColor: "#d4a574",
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => "₱" + Number(ctx.parsed.y || 0).toFixed(2),
            },
          },
        },
        scales: {
          x: {
            ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 },
          },
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v) => "₱" + v,
            },
          },
        },
      },
    })
  }

  if (insightsEl) {
    const top = items[0]
    const bottom = items[items.length - 1]
    const topPct = grandTotal ? (top.revenue / grandTotal * 100).toFixed(1) + "%" : "0%"
    const bottomPct = grandTotal ? (bottom.revenue / grandTotal * 100).toFixed(1) + "%" : "0%"
    const midIndex = Math.floor(items.length / 2)
    const middle = items[midIndex] || top
    insightsEl.innerHTML =
      "<strong>Prescriptive: Recommendations</strong> " +
      "<ul style=\"margin:4px 0 0 18px; padding:0; font-size:0.85rem;\">" +
      "<li>Hero product: <strong>" +
      top.name +
      "</strong> (" +
      topPct +
      " of revenue). Feature this in promos, bundles, and menu highlights.</li>" +
      "<li>Growth product: <strong>" +
      middle.name +
      "</strong>. Test small upsell prompts (e.g., barista suggestions or combo offers).</li>" +
      "<li>Weak product: <strong>" +
      bottom.name +
      "</strong> (" +
      bottomPct +
      " of revenue). Consider price adjustment, repositioning, or limited‑time promotions.</li>" +
      "</ul>"
  }
}

function scheduleAnalyticsUpdate() {
  const now = Date.now()
  if (now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
    return
  }
  
  if (analyticsUpdateTimer) clearTimeout(analyticsUpdateTimer)
  analyticsUpdateTimer = setTimeout(() => {
    if (typeof runDashboard === "function") {
      runDashboard().catch(e => console.error("Dashboard error:", e))
    }
  }, 300)
}

async function runDashboard() {
  if (isDashboardRunning) return
  isDashboardRunning = true
  lastUpdateTime = Date.now()
  try {
    const res = await loadAnalyticsTotals()
    const labels = res.labels || []
    const values = (res.values || []).map((v) => Number(v) || 0)
    const totalSales = Number(res.totalSales || 0)
    const totalQty = Number(res.totalQty || 0)
    const interval = document.getElementById("anInterval")?.value || "week"
    const chartType = "line"

    let descTitle = "Daily Sales"
    if (interval === "week") descTitle = "Weekly Sales"
    else if (interval === "month") descTitle = "Monthly Sales"
    else if (interval === "quarter") descTitle = "Quarterly Sales"
    else if (interval === "semiannual") descTitle = "Semi-Annual Sales"
    else if (interval === "annual") descTitle = "Annual Sales"
    
    const range = calculateDateRange(interval)
    const start = document.getElementById("anStart")?.value || range.start
    const end = document.getElementById("anEnd")?.value || range.end
    
    const userStart = document.getElementById("anStart")?.value
    const userEnd = document.getElementById("anEnd")?.value
    if (userStart || userEnd) {
        descTitle += ` (${start} to ${end})`
    }

    if (labels.length && values.length) {
      createDescriptiveChart(labels, values, chartType, descTitle)
    } else {
      const placeholders = []
      const zeroVals = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, "0")
        const da = String(d.getDate()).padStart(2, "0")
        placeholders.push(`${y}-${m}-${da}`)
        zeroVals.push(0)
      }
      createDescriptiveChart(placeholders, zeroVals, chartType, descTitle)
    }

    const predLabels = labels.length ? labels : []
    const predValues = values.length ? values : []
    if (predLabels.length && predValues.length) {
      createForecastChart(predLabels, predValues, interval)
    } else {
      const now = new Date()
      const dLabels = []
      const dValues = []
      for (let i = 14; i >= 1; i--) {
        const d = new Date(now.getTime() - i * 86400000)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, "0")
        const da = String(d.getDate()).padStart(2, "0")
        dLabels.push(`${y}-${m}-${da}`)
        dValues.push(0)
      }
      createForecastChart(dLabels, dValues, interval)
    }
    
    // Forecast title is now handled inside createForecastChart

    document
      .getElementById("kpiTotal")
      ?.replaceChildren(document.createTextNode("₱" + Number(totalSales || 0).toFixed(2)))
    document.getElementById("kpiQty")?.replaceChildren(document.createTextNode(String(totalQty)))
    const avg =
      values.length ? values.reduce((a, b) => a + Number(b || 0), 0) / values.length : 0
    document.getElementById("kpiAvg")?.replaceChildren(document.createTextNode("₱" + avg.toFixed(2)))

    let catTotals = {}
    
    // Determine range for Pie Chart
    let pieStart = start
    let pieEnd = end
    
    if (!userStart && !userEnd) {
        const today = new Date()
        let pieStartD = new Date(today)
        let pieEndD = new Date(today)
        
        if (interval === "day") {
            // Day -> Today (default)
        } else if (interval === "week") {
             // Week -> Start of current week (Monday)
             const day = today.getDay() || 7 // 1 (Mon) to 7 (Sun)
             pieStartD.setDate(today.getDate() - day + 1)
        } else if (interval === "month") {
             // Month -> Start of current month
             pieStartD.setDate(1)
        } else if (interval === "quarter") {
             // Start of current quarter
             const q = Math.floor(today.getMonth() / 3)
             pieStartD.setMonth(q * 3)
             pieStartD.setDate(1)
        } else if (interval === "semiannual") {
             // Start of current half-year
             const h = Math.floor(today.getMonth() / 6)
             pieStartD.setMonth(h * 6)
             pieStartD.setDate(1)
        } else if (interval === "annual") {
             // Start of current year
             pieStartD.setMonth(0)
             pieStartD.setDate(1)
        }
        
        const f = (d) => {
             const y = d.getFullYear()
             const m = String(d.getMonth() + 1).padStart(2, '0')
             const da = String(d.getDate()).padStart(2, '0')
             return `${y}-${m}-${da}`
        }
        pieStart = f(pieStartD)
        pieEnd = f(pieEndD)
    }

    try {
      catTotals = await loadCategoryTotals(pieStart, pieEnd)
    } catch (e) {
      console.error("Error loading categories:", e)
      catTotals = {}
    }

    let catEntries = Object.entries(catTotals)
        .filter(([k, v]) => Number(v) > 0)
        .sort((a, b) => b[1] - a[1])

    let catLabels = catEntries.map(e => e[0])
    let catValues = catEntries.map(e => Number(e[1]))
    
    if (catValues.length === 0) {
      catLabels = ["No Data"]
      catValues = [0]
    }
    
    let catTitlePrefix = "Sales by Category"
    if (interval === "day") catTitlePrefix = "Daily Sales"
    else if (interval === "week") catTitlePrefix = "Weekly Sales"
    else if (interval === "month") catTitlePrefix = "Monthly Sales"
    else if (interval === "quarter") catTitlePrefix = "Quarterly Sales"
    else if (interval === "semiannual") catTitlePrefix = "Semi-Annual Sales"
    else if (interval === "annual") catTitlePrefix = "Annual Sales"

    let catTitleSuffix = ` (${pieStart} to ${pieEnd})`
    console.log(`[v0] Rendering Pie Chart: ${catTitlePrefix} ${catTitleSuffix}`)
    createCategoryPieChart(catLabels, catValues, catTitlePrefix, catTitleSuffix)

    try {
      const prodData = await loadProductAnalyticsTotals(start, end)
      renderAnalyticsProductTable(prodData)
    } catch (e) {
      console.error("Error loading product analytics:", e)
      renderAnalyticsProductTable({ totals: {}, grandTotal: 0, grandQty: 0 })
    }

    // Overview: prescriptive recommendations (updates with filters)
    try {
      renderOverviewRecommendations({
        interval,
        start,
        end,
        labels,
        values,
        totalSales,
        totalQty,
        catEntries,
      })
    } catch (e) {
      console.warn("[v0] Overview recommendations failed:", e)
    }

    try {
      await renderProductTrendChart(start, end)
    } catch (e) {
      console.error("Error rendering product trend chart:", e)
    }

    try {
      await renderProductForecastChart(start, end)
    } catch (e) {
      console.error("Error rendering product forecast chart:", e)
    }
  } finally {
    isDashboardRunning = false
  }
}

function renderOverviewRecommendations({ interval, start, end, labels, values, totalSales, totalQty, catEntries }) {
  const el = document.getElementById("analyticsOverviewRecommendations")
  if (!el) return

  const safeTotal = Number(totalSales || 0)
  const safeQty = Number(totalQty || 0)
  const avgPerItem = safeQty ? safeTotal / Math.max(1, safeQty) : 0

  const series = (values || []).map((v) => Number(v || 0))
  const first = series.find((v) => v > 0) || 0
  const last = [...series].reverse().find((v) => v > 0) || 0
  const trendPct = first ? ((last - first) / first) * 100 : 0

  const topCat = catEntries && catEntries.length ? catEntries[0] : null

  const bullets = []
  if (topCat) {
    bullets.push(
      `Focus on your top category: <strong>${topCat[0]}</strong> (₱${Number(topCat[1] || 0).toFixed(
        2
      )} in this range). Feature it on the first screen and bundle with popular add‑ons.`
    )
  }

  if (trendPct <= -10) {
    bullets.push(
      `Sales are trending down (~${trendPct.toFixed(
        0
      )}%). Run a short promo (2–3 days) or bundle discount during low hours to lift demand.`
    )
  } else if (trendPct >= 10) {
    bullets.push(
      `Sales are trending up (~+${trendPct.toFixed(
        0
      )}%). Keep inventory ready for best sellers and add a simple upsell (e.g., pastry add‑on) to raise spend.`
    )
  } else {
    bullets.push(
      `Sales are stable. Improve average spend (about <strong>₱${avgPerItem.toFixed(
        2
      )}</strong> per item) by adding “recommended add‑ons” at checkout.`
    )
  }

  bullets.push(
    `Scope: <strong>${interval}</strong> (${start} → ${end}). Use the time analysis chart to schedule more staff during peak hours and run promos during slow hours.`
  )

  el.innerHTML = `<ul style="margin:0; padding-left:18px; line-height:1.5;">${bullets
    .map((b) => `<li>${b}</li>`)
    .join("")}</ul>`
}

// Generate hourly sales analysis to show when cafe is most active
async function generateTimeAnalysis() {
  const canvas = document.getElementById("analyticsTimeAnalysisChart")
  const insightsEl = document.getElementById("timeAnalysisInsights")
  if (!canvas || !insightsEl) return

  try {
    const { data: salesData } = await getDB().from("sales").select("*")
    const hourlyData = {}
    
    // Group sales by hour of day
    for (let h = 0; h < 24; h++) {
      hourlyData[h] = { count: 0, total: 0 }
    }
    
    if (salesData && Array.isArray(salesData)) {
      salesData.forEach((d) => {
        const date = new Date(d.created_at || d.date)
        const hour = date.getHours()
        hourlyData[hour].count += 1
        hourlyData[hour].total += Number(d.total || 0)
      })
    }
    
    const labels = Array.from({ length: 24 }, (_, i) => {
      const h = i < 12 ? i : i - 12
      const period = i < 12 ? 'AM' : 'PM'
      return `${h || 12}:00 ${period}`
    })
    const values = Array.from({ length: 24 }, (_, i) => hourlyData[i].total)
    const counts = Array.from({ length: 24 }, (_, i) => hourlyData[i].count)
    
    // Find peak and low hours (only among hours with activity)
    let peakHour = 0, peakVal = 0
    let lowHour = 0, lowVal = Infinity
    for (let i = 0; i < 24; i++) {
      if (values[i] > peakVal) {
        peakVal = values[i]
        peakHour = i
      }
      if (counts[i] > 0 && values[i] < lowVal) {
        lowVal = values[i]
        lowHour = i
      }
    }
    
    const peakHourDisplay = peakHour < 12 ? peakHour : peakHour - 12
    const peakPeriod = peakHour < 12 ? 'AM' : 'PM'
    const lowHourDisplay = lowHour < 12 ? lowHour : lowHour - 12
    const lowPeriod = lowHour < 12 ? 'AM' : 'PM'
    
    // Display insights
    insightsEl.innerHTML = `
      <strong>Peak Activity Times</strong>
      <ul style="margin:8px 0 0 18px; padding:0; font-size:0.85rem;">
        <li><strong>Busiest Hour:</strong> ${peakHourDisplay}:00 ${peakPeriod} (₱${peakVal.toFixed(2)} in sales)</li>
        <li><strong>Lowest Sales Hour:</strong> ${lowHourDisplay}:00 ${lowPeriod}</li>
        <li><strong>Recommendation:</strong> Maximize staffing during peak hours. Run promotions during low hours to boost traffic.</li>
      </ul>
    `
    
    // Create chart
    if (window.Chart) {
      if (window.timeAnalysisChartInstance) {
        window.timeAnalysisChartInstance.destroy()
      }
      window.timeAnalysisChartInstance = new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "Hourly Sales",
            data: values,
            borderColor: "#d4a574",
            backgroundColor: "rgba(212, 165, 116, 0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointBackgroundColor: "#d4a574"
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true },
            tooltip: {
              callbacks: {
                label: (ctx) => "₱" + Number(ctx.parsed.y || 0).toFixed(2)
              }
            }
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 12 }
            },
            y: {
              beginAtZero: true,
              ticks: {
                callback: (v) => "₱" + v
              }
            }
          }
        }
      })
    }
  } catch (e) {
    console.error("[v0] Time analysis error:", e)
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("[v0] Analytics page loaded, initializing...")

    const tabButtons = document.querySelectorAll(".analytics-tab-btn")
    const tabContents = document.querySelectorAll(".analytics-tab-content")
    if (tabButtons.length && tabContents.length) {
      tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const tab = btn.getAttribute("data-tab")
          tabButtons.forEach((b) => b.classList.remove("active"))
          tabContents.forEach((c) => c.classList.remove("active"))
          btn.classList.add("active")
          const target =
            tab === "product"
              ? document.getElementById("analyticsProductTab")
              : document.getElementById("analyticsOverviewTab")
          if (target) target.classList.add("active")
        })
      })
    }

    loadAnalyticsProductFilter()
    lastUpdateTime = Date.now()
    if (typeof runDashboard === "function") {
      runDashboard().catch(e => console.error("[v0] Dashboard error:", e))
    }

    // Real-time updates
    try {
        getDB().channel('analytics-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Sales' }, () => {
            scheduleAnalyticsUpdate()
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Orders' }, () => {
            scheduleAnalyticsUpdate()
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'PendingOrders', filter: "status=eq.completed" }, () => {
            scheduleAnalyticsUpdate()
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings', filter: "status=eq.completed" }, () => {
            scheduleAnalyticsUpdate()
        })
        .subscribe()
    } catch (e) {
      console.error("[v0] Analytics subscribe error:", e)
    }

    // Generate and display time-based analysis
    generateTimeAnalysis()

    const filterIds = ["anInterval", "anSource", "catMode", "descType", "anStart", "anEnd", "anProductForecastInterval"];
    filterIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          console.log(`[v0] Filter changed: ${id}`);
          
          // Clear manual date range if Interval is changed to avoid confusion
          if (id === "anInterval") {
              const startEl = document.getElementById("anStart");
              const endEl = document.getElementById("anEnd");
              if (startEl) startEl.value = "";
              if (endEl) endEl.value = "";
          }

          scheduleAnalyticsUpdate();
        });
      }
    });
  })
}

async function renderProductForecastChart(startArg, endArg) {
  const canvas = document.getElementById("analyticsProductForecastChart")
  const emptyEl = document.getElementById("analyticsProductForecastEmpty")
  const summaryEl = document.getElementById("analyticsProductForecastSummary")
  const metricsWrap = document.getElementById("analyticsProductHeaderMetrics")
  const metricPeriodEl = document.getElementById("analyticsMetricPeriod")
  const metricQtyEl = document.getElementById("analyticsMetricQty")
  const metricRevEl = document.getElementById("analyticsMetricRevenue")
  if (!canvas || !window.Chart) return

  const sel = document.getElementById("anProduct")
  if (!sel || !sel.value) {
    if (emptyEl) {
      emptyEl.textContent =
        "Select a product and forecast view to see projected sales."
      emptyEl.style.display = "flex"
    }
    if (summaryEl) {
      summaryEl.textContent = ""
    }
    if (metricsWrap) {
      metricsWrap.style.display = "none"
    }
    if (productForecastChartInstance) {
      productForecastChartInstance.destroy()
      productForecastChartInstance = null
    }
    return
  }

  const interval =
    document.getElementById("anProductForecastInterval")?.value || "day"

  let start = startArg
  let end = endArg
  if (!start || !end) {
    const range = calculateDateRange(interval)
    start = range.start
    end = range.end
  }

  const series = await loadProductTimeSeries(start, end, interval)
  if (!series || !series.labels.length) {
    if (emptyEl) {
      emptyEl.textContent =
        "Not enough data for this product in the selected forecast view."
      emptyEl.style.display = "flex"
    }
    if (summaryEl) {
      summaryEl.textContent = ""
    }
    if (metricsWrap) {
      metricsWrap.style.display = "none"
    }
    if (productForecastChartInstance) {
      productForecastChartInstance.destroy()
      productForecastChartInstance = null
    }
    return
  }

  const pastLabels = series.labels
  const pastValues = series.revenueValues.map((v) => Number(v) || 0)
  const pastQtyValues = (series.qtyValues || []).map((v) => Number(v) || 0)

  if (productForecastChartInstance) {
    productForecastChartInstance.destroy()
    productForecastChartInstance = null
  }

  let forecastCount = 14
  let legendLabel = "Forecast"
  if (interval === "week") {
    forecastCount = 8
    legendLabel = "8-Week Forecast"
  } else if (interval === "month") {
    forecastCount = 3
    legendLabel = "3-Month Forecast"
  } else {
    forecastCount = 14
    legendLabel = "14-Day Forecast"
  }

  const sorted = pastLabels.slice().sort()
  const revMap = new Map(pastLabels.map((l, i) => [l, pastValues[i]]))
  const qtyMap = new Map(pastLabels.map((l, i) => [l, pastQtyValues[i] || 0]))
  const sortedRevenue = sorted.map((l) => revMap.get(l) || 0)
  const sortedQty = sorted.map((l) => qtyMap.get(l) || 0)

  const windowSize =
    interval === "month"
      ? Math.min(sortedRevenue.length, 6)
      : interval === "week"
      ? Math.min(sortedRevenue.length, 8)
      : Math.min(sortedRevenue.length, 14)
  const startIdx = Math.max(0, sortedRevenue.length - windowSize)
  const reactiveRevenue =
    windowSize > 0 ? sortedRevenue.slice(startIdx) : sortedRevenue
  const reactiveQty = windowSize > 0 ? sortedQty.slice(startIdx) : sortedQty

  const forecast = generateForecast(reactiveRevenue, forecastCount)

  const lastDateStr = sorted[sorted.length - 1]
  let startDate = lastDateStr ? new Date(lastDateStr + "T00:00:00") : new Date()
  if (lastDateStr) {
    if (interval === "month" && lastDateStr.length === 7) {
      startDate = new Date(lastDateStr + "-01T00:00:00")
    } else if (interval === "week") {
      const parts = lastDateStr.split("-W")
      if (parts.length === 2) {
        const y = parseInt(parts[0])
        const w = parseInt(parts[1])
        const d = new Date(y, 0, 4)
        const day = (d.getDay() + 6) % 7
        d.setDate(d.getDate() - day + (w - 1) * 7)
        startDate = d
      }
    }
  }

  const futureLabels = []
  for (let i = 1; i <= forecast.length; i++) {
    let label = ""
    if (interval === "month") {
      const d = new Date(startDate)
      d.setMonth(d.getMonth() + i)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, "0")
      label = `${y}-${m}`
    } else if (interval === "week") {
      const d = new Date(startDate.getTime() + i * 7 * 86400000)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, "0")
      const da = String(d.getDate()).padStart(2, "0")
      label = `${y}-${m}-${da}`
    } else {
      const d = new Date(startDate.getTime() + i * 86400000)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, "0")
      const da = String(d.getDate()).padStart(2, "0")
      label = `${y}-${m}-${da}`
    }
    futureLabels.push(label)
  }

  const parent = canvas.parentNode
  const freshCanvas = document.createElement("canvas")
  freshCanvas.id = canvas.id
  freshCanvas.className = canvas.className
  freshCanvas.style.height = "100%"
  freshCanvas.style.width = "100%"
  freshCanvas.style.maxHeight = "none"
  parent.replaceChild(freshCanvas, canvas)

  const selText = sel.options[sel.selectedIndex]?.text || sel.value
  const titleEl = document.getElementById("productForecastTitle")
  if (titleEl) {
    const label =
      interval === "month" ? "Monthly" : interval === "week" ? "Weekly" : "Daily"
    titleEl.innerText = `Predictive: ${selText} Forecast (${label})`
  }

  const forecastTotal = forecast.reduce((a, b) => a + Number(b || 0), 0)
  const horizonLabel =
    interval === "month"
      ? "next 3 months"
      : interval === "week"
      ? "next 8 weeks"
      : "next 14 days"
  const historyLabel =
    interval === "month"
      ? "Last 3 months"
      : interval === "week"
      ? "Last 8 weeks"
      : "Last 14 days"
  const avgPerPeriod = forecast.length ? forecastTotal / forecast.length : 0
  const histQtyTotal = reactiveQty.reduce((a, b) => a + Number(b || 0), 0)
  const histRevTotal = reactiveRevenue.reduce((a, b) => a + Number(b || 0), 0)

  if (summaryEl) {
    summaryEl.innerHTML =
      "<strong>Expected " +
      selText +
      " sales " +
      horizonLabel +
      ":</strong> ₱" +
      forecastTotal.toFixed(2) +
      " (about ₱" +
      avgPerPeriod.toFixed(2) +
      " per period)."
  }

  if (metricsWrap && metricPeriodEl && metricQtyEl && metricRevEl) {
    if (reactiveRevenue.length) {
      const cupsLabel = histQtyTotal === 1 ? "cup" : "cups"
      metricPeriodEl.textContent = historyLabel
      metricQtyEl.textContent = histQtyTotal + " " + cupsLabel
      metricRevEl.textContent = "₱" + histRevTotal.toFixed(2)
      metricsWrap.style.display = "flex"
    } else {
      metricsWrap.style.display = "none"
    }
  }

  productForecastChartInstance = new window.Chart(freshCanvas, {
    type: "line",
    data: {
      labels: [...sorted, ...futureLabels],
      datasets: [
        {
          label: "Actual (₱)",
          data: [...sortedRevenue, ...new Array(forecast.length).fill(null)],
          backgroundColor: "transparent",
          borderColor: "#d4a574",
          borderWidth: 2,
          tension: 0.25,
        },
        {
          label: legendLabel,
          data: [...new Array(sortedRevenue.length).fill(null), ...forecast],
          borderColor: "#4b4b4b",
          backgroundColor: "transparent",
          borderWidth: 2,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              "₱" + Number(ctx.parsed.y || ctx.parsed || 0).toFixed(2),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (v) => "₱" + v,
          },
        },
      },
    },
  })

  if (emptyEl) {
    emptyEl.style.display = "none"
  }
}

// --- MIGRATED SALES & REPORTS FUNCTIONS ---

window.renderSales = async function() {
  const body = document.getElementById('salesBody');
  const totalEl = document.getElementById('salesTotal');
  const qtyEl = document.getElementById('salesQty');
  const headRow = document.getElementById('salesHeadRow');
  const mode = document.getElementById('salesMode').value;
  const start = document.getElementById('salesStart').value;
  const end = document.getElementById('salesEnd').value;
  
  if(body) body.innerHTML = '';
  if(totalEl) totalEl.textContent = '0.00';
  if(qtyEl) qtyEl.textContent = '0';
  
  try {
      const [prodRes, salesRes] = await Promise.all([
        getDB().from('products').select('*'),
        getDB().from('sales').select('*')
      ]);

      if (prodRes.error) throw prodRes.error;
      if (salesRes.error) throw salesRes.error;

      const prodMap={}; 
      prodRes.data.forEach(d=>{ 
          prodMap[d.id]={name:d.name, size:d.size, price:Number(d.price||0)}; 
      });

      let grand=0; let grandQty=0;
      const agg={};
      const detailsMap = {};

      const processDoc = (d) => {
          let dateStr = "";
          let dt = null;
          
          // Prioritize transaction date over booked date
          if (d.sale_date) {
              dt = new Date(d.sale_date);
          } else if (d.timestamp || d.created_at) {
              dt = new Date(d.timestamp || d.created_at);
          } else if (d.date) {
              dateStr = d.date;
              dt = new Date(dateStr + 'T00:00:00');
          }

          if (dt) {
              const y = dt.getFullYear();
              const m = String(dt.getMonth()+1).padStart(2,'0');
              const da = String(dt.getDate()).padStart(2,'0');
              dateStr = `${y}-${m}-${da}`;
          } else {
              return; // Skip invalid date
          }

          if(start && dateStr < start) return;
          if(end && dateStr > end) return;

          let key = dateStr;
          if(mode==='week') key=getWeekKey(dt); 
          else if(mode==='month') key=dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0');
          else if(mode==='quarter') key=getQuarterKey(dt);
          else if(mode==='semiannual') key=getSemiAnnualKey(dt);
          else if(mode==='annual') key=getAnnualKey(dt);

          let qty = 0;
          let total = 0;
          
          let items = d.items;
          if (typeof items === 'string') {
              try { items = JSON.parse(items); } catch(e) { items = []; }
          }

          if (items && Array.isArray(items) && items.length > 0) {
             qty = items.reduce((s,i)=>s+Number(i.quantity || i.qty || 0),0);
             
             if (d.total !== undefined && !isNaN(d.total)) {
                 total = Number(d.total);
             } else {
                 total = items.reduce((s,i)=>{ 
                    const pm=prodMap[i.id]; 
                    const price= pm ? pm.price : Number(i.price||0); 
                    const itemQty = Number(i.quantity || i.qty || 0);
                    return s + (Number(i.amount) || (price * itemQty)); 
                 },0);
             }
          } else {
             // Fallback if no items array
             total = Number(d.total || 0);
          }

          if(!agg[key]) agg[key]={total:0, qty:0}; 
          agg[key].total+=total; 
          agg[key].qty+=qty; 
          grand+=total; 
          grandQty+=qty;

          // Collect details for dropdown by period key
          const ts = dt.toISOString();
          let prettyItems = [];
          (items || []).forEach(i => {
            const nm = i.name || (prodMap[i.id]?.name) || "Item";
            const q = Number(i.quantity || i.qty || 0);
            const t = Number(i.amount || i.total || 0);
            let p = Number(i.price || prodMap[i.id]?.price || 0);
            
            // Fallback: If price is 0 but total and quantity are present, calculate it
            if (p === 0 && t > 0 && q > 0) {
              p = t / q;
            }
            
            prettyItems.push({ name: nm, qty: q, price: p, total: t });
          });
          if (!detailsMap[key]) detailsMap[key] = [];
          detailsMap[key].push({
            dateTime: ts,
            rawTs: dt.getTime(),
            total: total,
            items: prettyItems
          });
      };

      // Process Sales (Transaction records)
      // NOTE: We no longer include 'orders' or 'bookings' tables here because 
      // they are already represented in 'sales' when completed.
      (salesRes.data || []).forEach(d => {
          processDoc(d);
      });

      let modeLabel = 'Date';
      if(mode==='week') modeLabel='Week';
      else if(mode==='month') modeLabel='Month';
      else if(mode==='quarter') modeLabel='Quarter';
      else if(mode==='semiannual') modeLabel='Semi-Annual';
      else if(mode==='annual') modeLabel='Annual';
      
      if(headRow) headRow.innerHTML = `<th style="text-align: left; padding: 14px;">${modeLabel}</th><th style="text-align: right; padding: 14px;">Total</th><th style="text-align: center; padding: 14px;">Quantity</th>`;
      
      Object.keys(agg).sort().reverse().forEach(k=>{ 
          const tr=document.createElement('tr'); 
          tr.style.cursor = 'pointer';
          tr.title = 'Click to view transactions';
          tr.innerHTML=`<td style="text-align: left; padding: 14px; font-family: 'Courier New', Courier, monospace; font-weight: 600;">${k}</td><td style="text-align: right; padding: 14px; font-family: 'Courier New', Courier, monospace;">₱${agg[k].total.toFixed(2)}</td><td style="text-align: center; padding: 14px; font-family: 'Courier New', Courier, monospace;">${agg[k].qty}</td>`; 
          
          const trDetail = document.createElement('tr');
          trDetail.style.display = 'none';
          trDetail.style.backgroundColor = '#f8f9fa';
          const tdDetail = document.createElement('td');
          tdDetail.colSpan = 3;
          
          const list = (detailsMap[k] || []).sort((a,b) => (b.rawTs || 0) - (a.rawTs || 0));
          let html = '<div style="padding:12px 18px;">';
          if (list.length === 0) {
            html += '<em>No transactions recorded for this period.</em>';
          } else {
            html += '<div style="font-weight:600;margin-bottom:6px;">Transactions</div>';
            list.forEach((t, idx) => {
              html += `<div style="padding:10px 12px; border:1px solid #eaeaea; border-radius:6px; margin-bottom:8px; background:#fff;">`;
              html += `<div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span>#${idx+1}</span><strong>Total: ₱${Number(t.total||0).toFixed(2)}</strong></div>`;
              html += '<table style="width:100%; font-size:0.9em; border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:4px;">Product</th><th style="text-align:right;padding:4px;">Qty</th><th style="text-align:right;padding:4px;">Price</th><th style="text-align:right;padding:4px;">Total</th></tr></thead><tbody>';
              (t.items || []).forEach(it => {
                html += `<tr style="border-top:1px solid #f1f1f1;"><td style="padding:4px;">${it.name}</td><td style="padding:4px;text-align:right;">${it.qty}</td><td style="padding:4px;text-align:right;">₱${Number(it.price||0).toFixed(2)}</td><td style="padding:4px;text-align:right;">₱${Number(it.total||0).toFixed(2)}</td></tr>`;
              });
              html += '</tbody></table></div>';
            });
          }
          html += '</div>';
          tdDetail.innerHTML = html;
          trDetail.appendChild(tdDetail);
          
          tr.onclick = () => {
            const isHidden = trDetail.style.display === 'none';
            trDetail.style.display = isHidden ? 'table-row' : 'none';
            tr.style.backgroundColor = isHidden ? '#e2e6ea' : '';
          };
          
          if(body) {
            body.appendChild(tr);
            body.appendChild(trDetail);
          }
      });
      
      const sumRow=document.createElement('tr');
      sumRow.innerHTML=`<td style="text-align: left; padding: 14px; font-weight: bold;">Totals</td><td style="text-align: right; padding: 14px; font-weight: bold;">₱${grand.toFixed(2)}</td><td style="text-align: center; padding: 14px; font-weight: bold;">${grandQty}</td>`;
      if(body) body.appendChild(sumRow);
      
      if(totalEl) totalEl.textContent = grand.toFixed(2);
      if(qtyEl) qtyEl.textContent = String(grandQty);

  } catch (err) {
      console.error("Error rendering sales:", err);
      window.showMessage("Error loading sales data", "error");
  }
}

window.downloadSalesCSV = async function() {
    const start = document.getElementById('salesStart').value; 
    const end = document.getElementById('salesEnd').value;
    
    try {
        const [prodRes, salesRes] = await Promise.all([
            getDB().from('products').select('*'),
            getDB().from('sales').select('*')
        ]);

        const prodMap = {}; 
        (prodRes.data || []).forEach(d => { prodMap[d.id] = { price: Number(d.price || 0) }; });
        
        const rows = [['Date', 'Time', 'Product', 'Qty', 'Price (\u20B1)', 'Total (\u20B1)']];
        
        const processDoc = (d) => {
            let dateStr = "";
            let timeStr = "";
            let dt = null;
            
            if (d.sale_date) dt = new Date(d.sale_date);
            else if (d.timestamp || d.created_at) dt = new Date(d.timestamp || d.created_at);
            else if (d.date) {
                dateStr = d.date;
                dt = new Date(dateStr + 'T00:00:00');
            }

            if (dt) {
                const y = dt.getFullYear();
                const m = String(dt.getMonth() + 1).padStart(2, '0');
                const da = String(dt.getDate()).padStart(2, '0');
                dateStr = `${y}-${m}-${da}`;
                timeStr = dt.toLocaleTimeString([], { hour12: false });
            } else return;

            if (start && dateStr < start) return; 
            if (end && dateStr > end) return; 

            let items = d.items || [];
            if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch (e) { items = []; }
            }

            const itemsTotal = items.reduce((sum, it) => sum + (Number(it.amount) || (Number(it.price || 0) * Number(it.quantity || it.qty || 0))), 0);
            const storedTotal = Number(d.total || 0);
            const scaleFactor = (d.insufficient_payment === true && itemsTotal > 0) ? (storedTotal / itemsTotal) : 1;

            (items || []).forEach(it => { 
                const qty = Number(it.quantity || it.qty || 0); 
                const rawTotal = Number(it.amount || (Number(it.price || 0) * qty) || 0);
                let price = 0;
                
                if (prodMap[it.id]) price = prodMap[it.id].price;
                else if (it.price) price = Number(it.price);
                else if (qty > 0) price = rawTotal / qty;
                
                const finalTotal = (rawTotal || (price * qty)) * scaleFactor;
                const finalPrice = price * scaleFactor;
                
                // Quote string fields to handle commas
                rows.push([
                  `"${dateStr}"`, 
                  `"${timeStr}"`,
                  `"${(it.name || "Unknown").replace(/"/g, '""')}"`, 
                  qty, 
                  `"\u20B1${finalPrice.toFixed(2)}"`, 
                  `"\u20B1${finalTotal.toFixed(2)}"`
                ]); 
            }); 
        };

        (salesRes.data || []).forEach(d => processDoc(d));
        
        const csv = rows.map(r => r.join(',')).join('\n'); 
        // Use UTF-8 BOM to ensure Excel opens with correct encoding
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); 
        const url = URL.createObjectURL(blob); 
        const a = document.createElement('a'); 
        a.href = url; 
        a.download = `overall_sales_${new Date().toISOString().split('T')[0]}.csv`; 
        document.body.appendChild(a);
        a.click(); 
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("Error downloading overall sales CSV:", err);
        window.showMessage("Error generating CSV", "error");
    }
}

window.renderReports = async function() {
    const start=document.getElementById('repStart').value; 
    const end=document.getElementById('repEnd').value;
    const type='transaction';
    const body=document.getElementById('repItemBody');
    const head=document.getElementById('repItemHead');
    const title=document.getElementById('repTableTitle');
    
    const kpiTotal = document.getElementById('repKpiTotal');
    const kpi2Lbl = document.getElementById('repKpiLabel2');
    const kpi2Val = document.getElementById('repKpiValue2');
    const kpi3Lbl = document.getElementById('repKpiLabel3');
    const kpi3Val = document.getElementById('repKpiValue3');

    if(body) body.innerHTML='';
    
    if(type === 'transaction') {
        if(title) title.textContent = 'Transaction Log';
        if(head) head.innerHTML = '<tr><th>Date/Time</th><th>Items Count</th><th>Total Amount</th><th>Status</th></tr>';
        if(kpi2Lbl) kpi2Lbl.textContent = 'Total Transactions';
        if(kpi3Lbl) kpi3Lbl.textContent = 'Avg Transaction';
    } else {
        if(title) title.textContent = 'Item Performance';
        if(head) head.innerHTML = '<tr><th>Product Name</th><th>Qty Sold</th><th>Avg Price</th><th>Total Revenue</th><th>% of Sales</th></tr>';
        if(kpi2Lbl) kpi2Lbl.textContent = 'Total Items Sold';
        if(kpi3Lbl) kpi3Lbl.textContent = 'Top Selling Item';
    }

    try {
        const [prodRes, salesRes] = await Promise.all([
            getDB().from('products').select('*'),
            getDB().from('sales').select('*')
        ]);

        const prodMap={}; 
        (prodRes.data || []).forEach(d=>{ prodMap[d.id]={name:d.name, price:Number(d.price||0)}; });
        
        let grandTotal=0;
        let grandQty=0;
        let transCount=0;
        
        const transactions = [];
        const itemAgg = {};
        
        const processDoc = (d, id, isPending) => {
             let dateStr = "";
             let ts = null;

             // Prioritize transaction date (sale_date, timestamp, created_at) over booked date
             if (d.sale_date) {
                 ts = new Date(d.sale_date);
             } else if (d.created_at || d.timestamp) {
                 ts = new Date(d.created_at || d.timestamp);
             } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
                 // Fallback to booked date if no transaction timestamp exists
                 dateStr = d.date;
                 ts = new Date(dateStr + 'T00:00:00');
             } else return;

             if (ts && !dateStr) {
                 const y = ts.getFullYear();
                 const m = String(ts.getMonth()+1).padStart(2,'0');
                 const da = String(ts.getDate()).padStart(2,'0');
                 dateStr = `${y}-${m}-${da}`;
             }

             if(start && dateStr<start) return; 
             if(end && dateStr>end) return; 
             
             const dateTime = ts ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}` : dateStr;
             
             let docTotal = 0;
             let docQty = 0;
             const itemsList = [];
             
             let items = d.items || [];
             if (typeof items === 'string') {
                 try { items = JSON.parse(items); } catch(e) { items = []; }
             }
             
             // Handle flat order rows (Kiosk/Pending) that don't have 'items' array but have product fields
             if (items.length === 0 && d.product_id) {
                 items = [{
                     id: d.product_id,
                     name: d.name,
                     quantity: d.quantity,
                     price: d.price,
                     category_id: d.category_id
                 }];
             }

             const itemsTotal = items.reduce((sum, it) => sum + (Number(it.amount) || (Number(it.price || 0) * Number(it.quantity || it.qty || 0))), 0);
             const storedTotal = Number(d.total || 0);
             
             // Detection for partial/insufficient payments
             const isPartial = (d.insufficient_payment === true) || (itemsTotal > storedTotal && storedTotal > 0);
             
             // If this is an insufficient payment, we should scale the item revenues proportionally 
             // to ensure the total matches the actual paid amount.
             const scaleFactor = (isPartial && itemsTotal > 0) ? (storedTotal / itemsTotal) : 1;

             items.forEach(it => {
                 const q = Number(it.quantity || it.qty || 0);
                 const rawLineTotal = Number(it.amount || it.total || 0);
                 let price = Number(it.price || prodMap[it.id]?.price || 0);
                 
                 // Fallback: Calculate price if 0 but total and qty present
                 if (price === 0 && rawLineTotal > 0 && q > 0) {
                     price = rawLineTotal / q;
                 }
                 
                 // Apply scale factor if partial payment
                 const lineTotal = rawLineTotal * scaleFactor;
                 const finalPrice = price * scaleFactor;
                 
                 docTotal += lineTotal;
                 docQty += q;
                 
                 const pName = it.name || prodMap[it.id]?.name || 'Unknown';
                 itemsList.push({ name: pName, qty: q, price: finalPrice, total: lineTotal, originalPrice: price });

                 if(type === 'item') {
                     const key = it.id || pName;
                     if(!itemAgg[key]) itemAgg[key] = { name: pName, qty: 0, revenue: 0 };
                     itemAgg[key].qty += qty;
                     itemAgg[key].revenue += lineTotal;
                 }
             });
             
             // If items calculation is 0 or inconsistent with stored total, prioritize storedTotal
             if(docTotal === 0 && storedTotal > 0) docTotal = storedTotal;
             else if (Math.abs(docTotal - storedTotal) > 0.01 && storedTotal > 0) docTotal = storedTotal;

             grandTotal += docTotal;
             grandQty += docQty;
             transCount++;
             
             if(type === 'transaction') {
                 transactions.push({
                     dateTime,
                     rawTs: ts ? ts.getTime() : 0,
                     itemsCount: docQty,
                     total: docTotal,
                     status: isPartial ? 'Partial Payment' : 'Completed',
                     isPartial: isPartial,
                     fullAmount: itemsTotal,
                     items: itemsList
                 });
             }
        };

        // Process Sales records (transaction-level)
        // NOTE: We no longer include 'orders' or 'bookings' tables here because 
        // they are already represented in 'sales' when completed.
        (salesRes.data || []).forEach(d => {
            processDoc(d, d.id, false);
        });

        if(type === 'transaction') {
            transactions.sort((a,b) => (b.rawTs || 0) - (a.rawTs || 0));
            transactions.forEach((t) => {
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.title = 'Click to view details';
                
                let statusColor = 'green';
                let statusText = t.status;
                if (t.isPartial) {
                    statusColor = '#d39e00'; // Amber/Yellow
                    statusText = 'Partial Payment';
                }
                
                tr.innerHTML = `<td style="font-family: 'Courier New', Courier, monospace; font-weight: 600;">${t.dateTime}</td><td style="font-family: 'Courier New', Courier, monospace;">${t.itemsCount}</td><td style="font-family: 'Courier New', Courier, monospace;">₱${t.total.toFixed(2)}</td><td><span style="color:${statusColor};font-weight:bold">${statusText}</span></td>`;
                
                const trDetail = document.createElement('tr');
                trDetail.style.display = 'none';
                trDetail.style.backgroundColor = '#f8f9fa';
                
                const tdDetail = document.createElement('td');
                tdDetail.colSpan = 4;
                
                let html = '<div style="padding: 10px 20px; border-left: 3px solid #007bff;">';
                html += '<h4 style="margin: 0 0 10px 0; font-size: 0.9em; color: #555;">Transaction Details</h4>';
                
                if (t.isPartial) {
                    html += `<div style="margin-bottom: 10px; padding: 8px; background: #fff3cd; border: 1px solid #ffeeba; border-radius: 4px; color: #856404; font-size: 0.85em;">
                        <strong>Already Paid:</strong> ₱${t.total.toFixed(2)} of ₱${t.fullAmount.toFixed(2)} total amount.
                    </div>`;
                }

                html += '<table style="width:100%; font-size: 0.9em; border-collapse: collapse;">';
                html += '<thead style="background: #e9ecef;"><tr><th style="padding:5px; text-align:left;">Product</th><th style="padding:5px; text-align:right;">Qty</th><th style="padding:5px; text-align:right;">Original Price</th><th style="padding:5px; text-align:right;">Allocated Amount</th></tr></thead><tbody>';
                t.items.forEach(item => {
                    const priceDisplay = item.originalPrice ? item.originalPrice.toFixed(2) : (item.price/ (t.total/t.fullAmount)).toFixed(2);
                    html += `<tr style="border-bottom: 1px solid #eee;">
                        <td style="padding:5px;">${item.name}</td>
                        <td style="padding:5px; text-align:right;">${item.qty}</td>
                        <td style="padding:5px; text-align:right;">₱${priceDisplay}</td>
                        <td style="padding:5px; text-align:right; font-weight: bold;">₱${item.total.toFixed(2)}</td>
                    </tr>`;
                });
                html += '</tbody></table></div>';
                tdDetail.innerHTML = html;
                trDetail.appendChild(tdDetail);
                
                tr.onclick = () => {
                    const isHidden = trDetail.style.display === 'none';
                    trDetail.style.display = isHidden ? 'table-row' : 'none';
                    tr.style.backgroundColor = isHidden ? '#e2e6ea' : '';
                };
                
                if(body) {
                    body.appendChild(tr);
                    body.appendChild(trDetail);
                }
            });
            if(kpiTotal) kpiTotal.textContent = '₱' + grandTotal.toFixed(2);
            if(kpi2Val) kpi2Val.textContent = transCount;
            if(kpi3Val) kpi3Val.textContent = '₱' + (transCount ? (grandTotal/transCount).toFixed(2) : '0.00');
        } else {
            const items = Object.values(itemAgg);
            items.sort((a,b) => b.revenue - a.revenue);
            items.forEach(i => {
                const tr = document.createElement('tr');
                const avgPrice = i.qty ? i.revenue/i.qty : 0;
                const pct = grandTotal ? (i.revenue/grandTotal*100).toFixed(1) + '%' : '0%';
                tr.innerHTML = `<td>${i.name}</td><td>${i.qty}</td><td>₱${avgPrice.toFixed(2)}</td><td>₱${i.revenue.toFixed(2)}</td><td>${pct}</td>`;
                if(body) body.appendChild(tr);
            });
            if(kpiTotal) kpiTotal.textContent = '₱' + grandTotal.toFixed(2);
            if(kpi2Val) kpi2Val.textContent = grandQty;
            const topItem = items.length > 0 ? items[0] : null;
            if(kpi3Val) kpi3Val.textContent = topItem ? topItem.name : '-';
        }
    } catch(err) {
        console.error("Error rendering reports:", err);
        window.showMessage("Error loading report data", "error");
    }
}

window.downloadReportsCSV = async function() {
    const start = document.getElementById('repStart').value; 
    const end = document.getElementById('repEnd').value;
    
    try {
        const [prodRes, salesRes] = await Promise.all([
            getDB().from('products').select('*'),
            getDB().from('sales').select('*')
        ]);

        const prodMap = {}; 
        (prodRes.data || []).forEach(d => { prodMap[d.id] = { price: Number(d.price || 0) }; });
        
        const rows = [['Date', 'Time', 'Product Item', 'Qty', 'Total (\u20B1)']];
        
        (salesRes.data || []).forEach(d => {
            let dateStr = "";
            let timeStr = "";
            let dt = null;
            
            // Fix: Improved time extraction logic to ensure time always shows up
            if (d.sale_date) {
                dt = new Date(d.sale_date);
            } else if (d.created_at) {
                dt = new Date(d.created_at);
            } else if (d.timestamp) {
                dt = new Date(d.timestamp);
            } else if (d.date && typeof d.date === 'string' && d.date.includes('-')) {
                // Last resort fallback
                dt = new Date(d.date + 'T00:00:00');
            }

            if (dt && !isNaN(dt.getTime())) {
                const y = dt.getFullYear();
                const m = String(dt.getMonth() + 1).padStart(2, '0');
                const da = String(dt.getDate()).padStart(2, '0');
                dateStr = `${y}-${m}-${da}`;
                // Use 24h format for consistent CSV parsing
                timeStr = dt.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } else return;

            if (start && dateStr < start) return; 
            if (end && dateStr > end) return; 

            let items = d.items || [];
            if (typeof items === 'string') {
                try { items = JSON.parse(items); } catch (e) { items = []; }
            }

            // Handle kiosk orders that might not have an items array
            if (items.length === 0 && d.product_id) {
                items = [{
                    id: d.product_id,
                    name: d.name,
                    quantity: d.quantity || d.qty,
                    price: d.price,
                    amount: d.total
                }];
            }

            const itemsTotal = items.reduce((sum, it) => sum + (Number(it.amount) || (Number(it.price || 0) * Number(it.quantity || it.qty || 0))), 0);
            const storedTotal = Number(d.total || 0);
            const scaleFactor = (d.insufficient_payment === true && itemsTotal > 0) ? (storedTotal / itemsTotal) : 1;

            items.forEach(it => { 
                const qty = Number(it.quantity || it.qty || 0); 
                const rawTotal = Number(it.amount || (Number(it.price || 0) * qty) || 0);
                let price = 0;
                
                if (it.price) price = Number(it.price);
                else if (prodMap[it.id]) price = prodMap[it.id].price;
                else if (qty > 0) price = rawTotal / qty;
                
                const finalTotal = (rawTotal || (price * qty)) * scaleFactor;
                
                rows.push([
                  `"${dateStr}"`, 
                  `"${timeStr}"`,
                  `"${(it.name || "Unknown").replace(/"/g, '""')}"`, 
                  qty, 
                  `"\u20B1${finalTotal.toFixed(2)}"`
                ]); 
            }); 
        });

        if (rows.length <= 1) {
            window.showMessage("No data found for selected range", "error");
            return;
        }

        const csv = rows.map(r => r.join(',')).join('\n'); 
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); 
        const url = URL.createObjectURL(blob); 
        const a = document.createElement('a'); 
        a.href = url; 
        a.download = `sales_report_${new Date().toISOString().split('T')[0]}.csv`; 
        document.body.appendChild(a);
        a.click(); 
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("Error downloading sales CSV:", err);
        window.showMessage("Error generating CSV", "error");
    }
}

function showMessage(message, type) {
  console.log(`[${type}] ${message}`);
}

window.showSalesTab = function(tab) {
  const overallPanel = document.getElementById('salesOverallPanel');
  const productsPanel = document.getElementById('salesProductsPanel');
  const overallTab = document.getElementById('tabSalesOverall');
  const productsTab = document.getElementById('tabSalesProducts');

  if (tab === 'overall') {
    if (overallPanel) overallPanel.style.display = 'block';
    if (productsPanel) productsPanel.style.display = 'none';
    if (overallTab) overallTab.classList.add('active');
    if (productsTab) productsTab.classList.remove('active');
    renderSales();
  } else {
    if (overallPanel) overallPanel.style.display = 'none';
    if (productsPanel) productsPanel.style.display = 'block';
    if (overallTab) overallTab.classList.remove('active');
    if (productsTab) productsTab.classList.add('active');
    renderProductSales();
  }
};

window.handleProductSalesModeChange = function() {
  const mode = document.getElementById('productSalesMode').value;
  const startEl = document.getElementById('productSalesStart');
  const endEl = document.getElementById('productSalesEnd');
  const now = new Date();

  if (mode === 'daily') {
    // Clear dates for manual admin selection
    startEl.value = endEl.value = "";
  } else if (mode === 'weekly') {
    const curr = new Date();
    const first = curr.getDate() - curr.getDay();
    const last = first + 6;
    startEl.value = new Date(curr.setDate(first)).toISOString().split('T')[0];
    endEl.value = new Date(curr.setDate(last)).toISOString().split('T')[0];
  } else if (mode === 'monthly') {
    startEl.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    endEl.value = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  }
  // For 'custom', we leave the inputs as they are or let the user edit them
  renderProductSales();
};

window.renderProductSales = async function() {
  const body = document.getElementById('productSalesBody');
  const mode = document.getElementById('productSalesMode').value;
  const startEl = document.getElementById('productSalesStart');
  const endEl = document.getElementById('productSalesEnd');
  
  if (!body) return;

  const start = startEl ? startEl.value : '';
  const end = endEl ? endEl.value : '';

  // If daily mode and no date selected, wait for admin input
  if (mode === 'daily' && !start) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#999;">Please select a date to view daily performance.</td></tr>';
    return;
  }

  body.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';

  // For other modes, if start/end are still empty, default to today
  let queryStart = start;
  let queryEnd = end;
  
  if (mode === 'daily') {
    // For daily, if only start is picked, use it for end as well
    if (queryStart && !queryEnd) queryEnd = queryStart;
    if (!queryStart && queryEnd) queryStart = queryEnd;
  }

  if (!queryStart) queryStart = new Date().toISOString().split('T')[0];
  if (!queryEnd) queryEnd = new Date().toISOString().split('T')[0];

  try {
    const { data: sales, error } = await getDB()
      .from('sales')
      .select('items, total, timestamp, date, sale_date')
      .gte('date', queryStart)
      .lte('date', queryEnd);

    if (error) throw error;

    const productStats = {};

    (sales || []).forEach(d => {
      const saleDate = d.date || (d.sale_date ? d.sale_date.split('T')[0] : (d.timestamp ? d.timestamp.split('T')[0] : 'Unknown'));
      let items = d.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch(e) { items = []; }
      }
      
      // Fallback for single-product sales records (kiosk legacy)
      if ((!items || items.length === 0) && d.product_id) {
        items = [{
          id: d.product_id,
          name: d.name || 'Unknown Product',
          quantity: d.quantity || d.qty || 1,
          price: d.price || (d.total / (d.quantity || d.qty || 1)),
          amount: d.total
        }];
      }

      if (items && Array.isArray(items)) {
        items.forEach(item => {
          const name = item.name || 'Unknown Product';
          const qty = Number(item.quantity || item.qty || 0);
          let price = Number(item.price || 0);
          let amount = Number(item.amount || item.total || 0);
          
          // Fallback: Calculate amount from price if missing, or price from amount if missing
          if (amount === 0 && price > 0) amount = price * qty;
          if (price === 0 && amount > 0 && qty > 0) price = amount / qty;
          
          const key = `${saleDate}|${name}`;
          if (!productStats[key]) {
            productStats[key] = { date: saleDate, name: name, qty: 0, amount: 0 };
          }
          productStats[key].qty += qty;
          productStats[key].amount += amount;
        });
      }
    });

    body.innerHTML = '';
    const sortedProducts = Object.values(productStats).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.amount - a.amount;
    });
    
    if (sortedProducts.length === 0) {
      body.innerHTML = '<tr><td colspan="4">No sales found for this period.</td></tr>';
      return;
    }

    // Find the max quantity and amount for progress bars and badges
    const maxQty = Math.max(...Object.values(productStats).map(s => s.qty));

    sortedProducts.forEach((stats, index) => {
      const tr = document.createElement('tr');
      const qtyPercent = (stats.qty / maxQty) * 100;
      const isTopSeller = index === 0; // Top overall in the list (most recent date, highest amount)
      const isTopQty = stats.qty === maxQty;

      tr.innerHTML = `
        <td style="padding: 14px; border-bottom: 1px solid var(--border-color); text-align: left; color: var(--coffee-medium); font-size: 0.9rem; font-family: 'Courier New', Courier, monospace; font-weight: 600;">
          ${stats.date}
        </td>
        <td style="padding: 14px; border-bottom: 1px solid var(--border-color); text-align: left;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-weight: 600; color: var(--coffee-dark);">${stats.name}</span>
            ${isTopSeller ? '<span style="background: #ffd700; color: #000; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase;">Top Revenue</span>' : ''}
            ${isTopQty && !isTopSeller ? '<span style="background: #e3f2fd; color: #1976d2; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase;">Best Seller</span>' : ''}
          </div>
        </td>
        <td style="padding: 14px; border-bottom: 1px solid var(--border-color); text-align: center;">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
            <span style="font-weight: 600;">${stats.qty}</span>
            <div style="width: 100px; height: 6px; background: #eee; border-radius: 3px; overflow: hidden;">
              <div style="width: ${qtyPercent}%; height: 100%; background: var(--accent-warm); border-radius: 3px;"></div>
            </div>
          </div>
        </td>
        <td style="padding: 14px; border-bottom: 1px solid var(--border-color); text-align: right;">
          <span style="font-weight: 700; color: var(--coffee-dark); font-size: 1.05rem;">₱${stats.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </td>
      `;
      body.appendChild(tr);
    });
  } catch (err) {
    console.error("Error rendering product sales:", err);
    body.innerHTML = `<tr><td colspan="3" style="color:red">Error: ${err.message}</td></tr>`;
  }
};

window.downloadProductSalesCSV = async function() {
  const mode = document.getElementById('productSalesMode').value;
  const startEl = document.getElementById('productSalesStart');
  const endEl = document.getElementById('productSalesEnd');
  
  let queryStart = startEl ? startEl.value : '';
  let queryEnd = endEl ? endEl.value : '';

  if (mode === 'daily') {
    if (queryStart && !queryEnd) queryEnd = queryStart;
    if (!queryStart && queryEnd) queryStart = queryEnd;
  }

  if (!queryStart) queryStart = new Date().toISOString().split('T')[0];
  if (!queryEnd) queryEnd = new Date().toISOString().split('T')[0];

  try {
    const { data: sales, error } = await getDB()
      .from('sales')
      .select('items, total, timestamp, date, sale_date')
      .gte('date', queryStart)
      .lte('date', queryEnd);

    if (error) throw error;

    const productStats = {};
    (sales || []).forEach(d => {
      const dt = new Date(d.date || d.sale_date || d.timestamp || d.created_at);
      const saleDate = dt.toISOString().split('T')[0];
      const saleTime = dt.toLocaleTimeString([], { hour12: false });
      
      let items = d.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch(e) { items = []; }
      }
      
      if (items && Array.isArray(items)) {
        items.forEach(item => {
          const name = item.name || 'Unknown Product';
          const qty = Number(item.quantity || item.qty || 0);
          const price = Number(item.price || 0);
          const amount = Number(item.amount || (price * qty));
          
          const key = `${saleDate}|${saleTime}|${name}`;
          if (!productStats[key]) {
            productStats[key] = { date: saleDate, time: saleTime, name: name, qty: 0, amount: 0 };
          }
          productStats[key].qty += qty;
          productStats[key].amount += amount;
        });
      }
    });

    const rows = [['Date', 'Time', 'Product Name', 'Quantity Sold', 'Total Amount (\u20B1)', 'Label']];
    const sortedProducts = Object.values(productStats).sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.time !== b.time) return b.time.localeCompare(a.time);
      return b.amount - a.amount;
    });
    
    const maxQty = Math.max(...Object.values(productStats).map(s => s.qty), 0);
    
    sortedProducts.forEach((stats, index) => {
      let label = "";
      const isTopRevenue = index === 0;
      const isBestSeller = stats.qty === maxQty && maxQty > 0;

      if (isTopRevenue && isBestSeller) label = "Top Revenue & Best Seller";
      else if (isTopRevenue) label = "Top Revenue";
      else if (isBestSeller) label = "Best Seller";

      rows.push([
        `"${stats.date}"`,
        `"${stats.time}"`,
        `"${stats.name.replace(/"/g, '""')}"`, 
        stats.qty, 
        `"\u20B1${stats.amount.toFixed(2)}"`,
        `"${label}"`
      ]);
    });

    if (rows.length === 1) {
      window.showMessage("No data to download", "info");
      return;
    }

    const csv = rows.map(r => r.join(',')).join('\n');
    // Use UTF-8 BOM to ensure Excel opens with correct encoding
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `product_performance_${queryStart}_to_${queryEnd}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Error downloading product sales CSV:", err);
    window.showMessage("Error generating CSV: " + err.message, "error");
  }
};
