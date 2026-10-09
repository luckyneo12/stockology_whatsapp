/**
 * Stockology WhatsCRM — Enhanced Agent & Team Management Dashboard
 * High-performance, reactive UI/UX for http://192.168.0.60:8001/user?page=agent-login
 */

(function () {
  'use strict';

  let allAgents = [];
  let filteredAgents = [];
  let departmentsMap = {};
  let teamsMap = {};
  let currentFilters = {
    search: '',
    department: 'ALL',
    team: 'ALL',
    role: 'ALL',
    status: 'ALL',
  };
  let pagination = {
    page: 1,
    pageSize: 50,
  };
  let isMounted = false;
  let isLoading = false;
  let pollInterval = null;

  // Role color palette
  const avatarColors = [
    '#3b82f6', '#10b981', '#6366f1', '#8b5cf6', 
    '#ec4899', '#f59e0b', '#06b6d4', '#14b8a6', 
    '#f97316', '#64748b'
  ];

  function getAvatarColor(name) {
    if (!name) return avatarColors[0];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return avatarColors[Math.abs(hash) % avatarColors.length];
  }

  function parseAgentMeta(agent) {
    let meta = {
      deptName: 'General',
      deptHead: '',
      teamName: 'No Team',
      teamLeader: '',
      role: 'MEMBER',
      status: agent.is_active ? 'ACTIVE' : 'INACTIVE',
    };

    if (agent.comments) {
      const jsonIdx = agent.comments.indexOf('-- {');
      if (jsonIdx !== -1) {
        try {
          const parsed = JSON.parse(agent.comments.substring(jsonIdx + 3));
          if (parsed.departmentName) meta.deptName = parsed.departmentName;
          if (parsed.departmentHead) meta.deptHead = parsed.departmentHead;
          if (parsed.teamName) meta.teamName = parsed.teamName;
          if (parsed.teamLeader) meta.teamLeader = parsed.teamLeader;
          if (parsed.role) meta.role = parsed.role;
          if (parsed.status) meta.status = parsed.status;
        } catch (_) {}
      } else {
        const parts = agent.comments.split('|').map(s => s.trim());
        if (parts[0]) meta.deptName = parts[0].replace(/^🏢\s*/, '');
        if (parts[1]) meta.teamName = parts[1].replace(/^👥\s*/, '');
        if (parts[2]) meta.role = parts[2];
        if (parts[3]) meta.status = parts[3];
      }
    }
    return meta;
  }

  function showToast(message, type = 'info') {
    let container = document.getElementById('ea-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ea-toast-container';
      container.className = 'ea-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'ea-toast ' + type;
    toast.innerHTML = '<span>' + escapeHtml(message) + '</span>';
    container.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function fetchAgents() {
    isLoading = true;
    renderPortalState();
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/get_my_agents', {
        headers: {
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
      });
      const data = await res.json();
      if (data && data.success && Array.isArray(data.data)) {
        allAgents = data.data.map(agent => {
          return {
            ...agent,
            meta: parseAgentMeta(agent),
          };
        });
        buildMetaDictionaries();
        applyFilters();
      } else {
        showToast(data.msg || 'Could not load agents list', 'error');
      }
    } catch (err) {
      console.error('[Enhanced Agents] Fetch error:', err);
      showToast('Error connecting to WhatsApp agent API', 'error');
    } finally {
      isLoading = false;
      renderPortalState();
    }
  }

  function buildMetaDictionaries() {
    departmentsMap = {};
    teamsMap = {};

    allAgents.forEach(ag => {
      const dept = ag.meta.deptName || 'General';
      const team = ag.meta.teamName || 'No Team';

      if (!departmentsMap[dept]) {
        departmentsMap[dept] = { count: 0, head: ag.meta.deptHead, teams: new Set() };
      }
      departmentsMap[dept].count++;
      departmentsMap[dept].teams.add(team);

      if (!teamsMap[team]) {
        teamsMap[team] = { count: 0, leader: ag.meta.teamLeader, dept: dept };
      }
      teamsMap[team].count++;
    });
  }

  function applyFilters() {
    const q = currentFilters.search.toLowerCase().trim();
    const dept = currentFilters.department;
    const team = currentFilters.team;
    const role = currentFilters.role;
    const status = currentFilters.status;

    filteredAgents = allAgents.filter(ag => {
      // Status filter
      if (status === 'ACTIVE' && !ag.is_active) return false;
      if (status === 'INACTIVE' && ag.is_active) return false;

      // Department filter
      if (dept !== 'ALL' && ag.meta.deptName !== dept) return false;

      // Team filter
      if (team !== 'ALL' && ag.meta.teamName !== team) return false;

      // Role filter
      if (role !== 'ALL') {
        const agRole = (ag.meta.role || '').toUpperCase();
        if (role === 'HEAD' && !agRole.includes('OWNER') && !agRole.includes('ADMIN')) return false;
        if (role === 'LEADER' && !agRole.includes('MANAGER') && !agRole.includes('LEAD')) return false;
        if (role === 'MEMBER' && (agRole.includes('MANAGER') || agRole.includes('OWNER') || agRole.includes('ADMIN'))) return false;
      }

      // Search query
      if (q) {
        const matchName = (ag.name || '').toLowerCase().includes(q);
        const matchEmail = (ag.email || '').toLowerCase().includes(q);
        const matchMobile = (ag.mobile || '').toLowerCase().includes(q);
        const matchDept = (ag.meta.deptName || '').toLowerCase().includes(q);
        const matchTeam = (ag.meta.teamName || '').toLowerCase().includes(q);
        const matchHead = (ag.meta.deptHead || '').toLowerCase().includes(q);
        const matchLead = (ag.meta.teamLeader || '').toLowerCase().includes(q);
        if (!matchName && !matchEmail && !matchMobile && !matchDept && !matchTeam && !matchHead && !matchLead) {
          return false;
        }
      }

      return true;
    });

    pagination.page = 1;
    renderPortalState();
  }

  // --------------------------------------------------------------------------
  // Agent Actions
  // --------------------------------------------------------------------------

  async function handleAutoLogin(agentUid, agentName) {
    showToast('Logging into WhatsApp Inbox for ' + agentName + '...', 'info');
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/user/auto_agent_login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ uid: agentUid }),
      });
      const data = await res.json();
      if (data && data.success && data.token) {
        localStorage.setItem('wacrm_agent', data.token);
        window.open('/agent', '_blank');
        showToast('Opened Smart Inbox in new tab!', 'success');
      } else {
        showToast(data.msg || 'Auto-login failed', 'error');
      }
    } catch (err) {
      showToast('Error during agent auto-login', 'error');
    }
  }

  async function handleToggleActiveness(agentUid, newStatus) {
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/change_agent_activeness', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ agentUid, activeness: newStatus }),
      });
      const data = await res.json();
      if (data && data.success) {
        const ag = allAgents.find(a => a.uid === agentUid);
        if (ag) {
          ag.is_active = newStatus ? 1 : 0;
          ag.meta.status = newStatus ? 'ACTIVE' : 'INACTIVE';
        }
        applyFilters();
        showToast('Updated status to ' + (newStatus ? 'Active' : 'Inactive'), 'success');
      } else {
        showToast(data.msg || 'Failed to update status', 'error');
      }
    } catch (err) {
      showToast('Error updating status', 'error');
    }
  }

  async function handleToggleMask(agentUid, newStatus) {
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/change_status_mask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ agentUid, activeness: newStatus }),
      });
      const data = await res.json();
      if (data && data.success) {
        const ag = allAgents.find(a => a.uid === agentUid);
        if (ag) ag.mask_number = newStatus ? 1 : 0;
        applyFilters();
        showToast('Mask phone updated', 'success');
      }
    } catch (_) {}
  }

  async function handleToggleAllowSend(agentUid, newStatus) {
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/change_status_allow_send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ agentUid, activeness: newStatus }),
      });
      const data = await res.json();
      if (data && data.success) {
        const ag = allAgents.find(a => a.uid === agentUid);
        if (ag) ag.allow_send_new_qr = newStatus ? 1 : 0;
        applyFilters();
        showToast('Allow send QR updated', 'success');
      }
    } catch (_) {}
  }

  async function handleDeleteAgent(agentUid, agentName) {
    if (!window.confirm('Are you sure you want to delete ' + agentName + '?')) return;
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/del_agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ uid: agentUid }),
      });
      const data = await res.json();
      if (data && data.success) {
        showToast('Agent deleted successfully', 'success');
        fetchAgents();
      } else {
        showToast(data.msg || 'Could not delete agent', 'error');
      }
    } catch (err) {
      showToast('Error deleting agent', 'error');
    }
  }

  async function handleViewChats(agentUid, agentName) {
    try {
      const token = localStorage.getItem('wacrm_user');
      const res = await fetch('/api/agent/get_agent_chats_owner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'token_user': token,
        },
        body: JSON.stringify({ uid: agentUid }),
      });
      const data = await res.json();
      const chats = (data && data.success && Array.isArray(data.data)) ? data.data : [];
      openChatsModal(agentName, chats);
    } catch (err) {
      showToast('Could not fetch chats', 'error');
    }
  }

  async function handleSyncCrm() {
    const btn = document.getElementById('ea-btn-sync');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="ea-spinner"></span> Syncing CRM Users...';
    }
    showToast('Syncing all users and hierarchy from CRM...', 'info');

    try {
      const res = await fetch('/api/sso/sync-crm-users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'token_user': localStorage.getItem('wacrm_user'),
        },
      });
      const data = await res.json();
      if (data && data.success) {
        showToast(data.message || 'Successfully synced CRM users!', 'success');
        await fetchAgents();
      } else {
        showToast(data.error || 'CRM sync returned an error', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error communicating with sync service', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🔄 Sync from CRM';
      }
    }
  }

  function handleExportCsv() {
    if (!filteredAgents || filteredAgents.length === 0) {
      showToast('No agents to export', 'error');
      return;
    }

    const headers = ['ID', 'Name', 'Email', 'Mobile', 'Department', 'Department Head', 'Team', 'Team Leader', 'Role', 'Status', 'Mask Mobile', 'Allow Send'];
    const rows = filteredAgents.map((ag, idx) => [
      idx + 1,
      '"' + (ag.name || '').replace(/"/g, '""') + '"',
      '"' + (ag.email || '').replace(/"/g, '""') + '"',
      '"' + (ag.mobile || '').replace(/"/g, '""') + '"',
      '"' + (ag.meta.deptName || '').replace(/"/g, '""') + '"',
      '"' + (ag.meta.deptHead || '').replace(/"/g, '""') + '"',
      '"' + (ag.meta.teamName || '').replace(/"/g, '""') + '"',
      '"' + (ag.meta.teamLeader || '').replace(/"/g, '""') + '"',
      '"' + (ag.meta.role || '').replace(/"/g, '""') + '"',
      ag.is_active ? 'Active' : 'Inactive',
      ag.mask_number ? 'Yes' : 'No',
      ag.allow_send_new_qr ? 'Yes' : 'No',
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'whatsapp_agents_' + new Date().toISOString().slice(0, 10) + '.csv');
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Exported ' + filteredAgents.length + ' agents to CSV', 'success');
  }

  function openChatsModal(agentName, chats) {
    let backdrop = document.getElementById('ea-chats-modal');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'ea-chats-modal';
      backdrop.className = 'ea-modal-backdrop';
      document.body.appendChild(backdrop);
    }

    let chatsListHtml = '';
    if (!chats || chats.length === 0) {
      chatsListHtml = '<div class="ea-empty-state"><div class="ea-empty-icon">💬</div><p>No active chats assigned to this agent yet.</p></div>';
    } else {
      chatsListHtml = '<div style="display:flex;flex-direction:column;gap:10px;">' +
        chats.map(c => `
          <div style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-weight:600;color:#0f172a;font-size:0.86rem;">${escapeHtml(c.sender_name || c.sender_mobile || 'Contact')}</div>
              <div style="font-size:0.75rem;color:#64748b;margin-top:2px;">${escapeHtml(c.sender_mobile || '')}</div>
            </div>
            <div style="text-align:right;">
              <span style="font-size:0.7rem;background:#ecfdf5;color:#059669;padding:2px 8px;border-radius:999px;font-weight:600;">Active</span>
            </div>
          </div>
        `).join('') +
        '</div>';
    }

    backdrop.innerHTML = `
      <div class="ea-modal-content">
        <div class="ea-modal-header">
          <h3>Chats — ${escapeHtml(agentName)} (${chats.length})</h3>
          <button class="ea-modal-close" onclick="document.getElementById('ea-chats-modal').classList.remove('open')">&times;</button>
        </div>
        <div>${chatsListHtml}</div>
      </div>
    `;

    backdrop.onclick = (e) => {
      if (e.target === backdrop) backdrop.classList.remove('open');
    };
    backdrop.classList.add('open');
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  function renderPortalState() {
    const portal = document.getElementById('enhanced-agents-portal');
    if (!portal) return;

    // Counts
    const totalCount = allAgents.length;
    const activeCount = allAgents.filter(a => a.is_active).length;
    const inactiveCount = totalCount - activeCount;
    const deptsCount = Object.keys(departmentsMap).length;
    const teamsCount = Object.keys(teamsMap).length;

    // Pagination slice
    const totalFiltered = filteredAgents.length;
    const pageSize = pagination.pageSize === -1 ? totalFiltered : pagination.pageSize;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
    const startIdx = (pagination.page - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalFiltered);
    const pageAgents = filteredAgents.slice(startIdx, endIdx);

    // Build Department Options
    const sortedDepts = Object.keys(departmentsMap).sort();
    const deptOptionsHtml = ['<option value="ALL">All Departments (' + totalCount + ')</option>']
      .concat(sortedDepts.map(d => `<option value="${escapeHtml(d)}" ${currentFilters.department === d ? 'selected' : ''}>${escapeHtml(d)} (${departmentsMap[d].count})</option>`))
      .join('');

    // Build Team Options (cascades with department)
    let availableTeams = [];
    if (currentFilters.department !== 'ALL' && departmentsMap[currentFilters.department]) {
      availableTeams = Array.from(departmentsMap[currentFilters.department].teams);
    } else {
      availableTeams = Object.keys(teamsMap).sort();
    }
    const teamOptionsHtml = ['<option value="ALL">All Teams</option>']
      .concat(availableTeams.map(t => `<option value="${escapeHtml(t)}" ${currentFilters.team === t ? 'selected' : ''}>${escapeHtml(t)} (${teamsMap[t]?.count || 0})</option>`))
      .join('');

    portal.innerHTML = `
      <!-- Header -->
      <div class="ea-header">
        <div class="ea-header-left">
          <div class="ea-header-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="ea-header-title-wrap">
            <h1>
              Agent & Team Management
              <span class="ea-header-badge">✨ Live CRM Synced</span>
            </h1>
            <p>Direct WhatsApp Smart Inbox allocation & role hierarchy for Stockology CRM executives.</p>
          </div>
        </div>
        <div class="ea-header-actions">
          <button id="ea-btn-sync" class="ea-btn ea-btn-sync">
            🔄 Sync from CRM
          </button>
          <button id="ea-btn-export" class="ea-btn ea-btn-secondary">
            📥 Export CSV
          </button>
        </div>
      </div>

      <!-- KPI Stats -->
      <div class="ea-stats-grid">
        <div class="ea-stat-card">
          <div class="ea-stat-icon blue">👥</div>
          <div class="ea-stat-info">
            <div class="ea-stat-value">${totalCount}</div>
            <div class="ea-stat-label">Total Executives</div>
            <div class="ea-stat-sub">All CRM members</div>
          </div>
        </div>
        <div class="ea-stat-card">
          <div class="ea-stat-icon green">🟢</div>
          <div class="ea-stat-info">
            <div class="ea-stat-value">${activeCount}</div>
            <div class="ea-stat-label">Active on WhatsApp</div>
            <div class="ea-stat-sub">Enabled for inbox</div>
          </div>
        </div>
        <div class="ea-stat-card">
          <div class="ea-stat-icon slate">⚪</div>
          <div class="ea-stat-info">
            <div class="ea-stat-value">${inactiveCount}</div>
            <div class="ea-stat-label">Inactive in CRM</div>
            <div class="ea-stat-sub">Disabled / Leavers</div>
          </div>
        </div>
        <div class="ea-stat-card">
          <div class="ea-stat-icon purple">🏢</div>
          <div class="ea-stat-info">
            <div class="ea-stat-value">${deptsCount}</div>
            <div class="ea-stat-label">Departments</div>
            <div class="ea-stat-sub">Sales & Operations</div>
          </div>
        </div>
        <div class="ea-stat-card">
          <div class="ea-stat-icon amber">👥</div>
          <div class="ea-stat-info">
            <div class="ea-stat-value">${teamsCount}</div>
            <div class="ea-stat-label">Calling Teams</div>
            <div class="ea-stat-sub">Active Units</div>
          </div>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="ea-toolbar">
        <div class="ea-toolbar-top">
          <!-- Search -->
          <div class="ea-search-wrap">
            <span class="ea-search-icon">🔍</span>
            <input type="text" id="ea-search-input" class="ea-search-input" placeholder="Search by Name, Email, Mobile, Dept, Team, or Leader..." value="${escapeHtml(currentFilters.search)}" />
            <button id="ea-search-clear" class="ea-search-clear" style="display:${currentFilters.search ? 'block' : 'none'};">&times;</button>
          </div>

          <!-- Dropdowns -->
          <div class="ea-filters-group">
            <div class="ea-select-wrap">
              <select id="ea-dept-select" class="ea-select">
                ${deptOptionsHtml}
              </select>
              <span class="ea-select-chevron">▼</span>
            </div>

            <div class="ea-select-wrap">
              <select id="ea-team-select" class="ea-select">
                ${teamOptionsHtml}
              </select>
              <span class="ea-select-chevron">▼</span>
            </div>

            <div class="ea-select-wrap" style="min-width:140px;">
              <select id="ea-role-select" class="ea-select">
                <option value="ALL">All Roles</option>
                <option value="HEAD" ${currentFilters.role === 'HEAD' ? 'selected' : ''}>👑 Department Head</option>
                <option value="LEADER" ${currentFilters.role === 'LEADER' ? 'selected' : ''}>🛡️ Team Leader</option>
                <option value="MEMBER" ${currentFilters.role === 'MEMBER' ? 'selected' : ''}>🎧 Telecaller / Member</option>
              </select>
              <span class="ea-select-chevron">▼</span>
            </div>
          </div>
        </div>

        <div class="ea-toolbar-bottom">
          <!-- Status Tabs -->
          <div class="ea-status-tabs">
            <button class="ea-status-tab ${currentFilters.status === 'ALL' ? 'active' : ''}" data-status="ALL">
              All <span class="ea-tab-count">${totalCount}</span>
            </button>
            <button class="ea-status-tab ${currentFilters.status === 'ACTIVE' ? 'active' : ''}" data-status="ACTIVE">
              Active <span class="ea-tab-count">${activeCount}</span>
            </button>
            <button class="ea-status-tab ${currentFilters.status === 'INACTIVE' ? 'active' : ''}" data-status="INACTIVE">
              Inactive <span class="ea-tab-count">${inactiveCount}</span>
            </button>
          </div>

          <div class="ea-meta-summary">
            <span>Showing <strong>${totalFiltered === 0 ? 0 : startIdx + 1} - ${endIdx}</strong> of <strong>${totalFiltered}</strong> executives</span>
            ${(currentFilters.search || currentFilters.department !== 'ALL' || currentFilters.team !== 'ALL' || currentFilters.role !== 'ALL' || currentFilters.status !== 'ALL') ? `
              <button id="ea-btn-reset-filters" class="ea-btn-reset">✕ Reset Filters</button>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- Table -->
      <div class="ea-card-table">
        <div class="ea-table-responsive">
          <table class="ea-table">
            <thead>
              <tr>
                <th style="width:50px;">#</th>
                <th style="min-width:200px;">Executive / Agent</th>
                <th style="min-width:170px;">Department</th>
                <th style="min-width:170px;">Team</th>
                <th style="width:130px;">Role</th>
                <th style="width:140px;text-align:center;">WhatsApp Inbox</th>
                <th style="width:90px;text-align:center;">Active</th>
                <th style="width:90px;text-align:center;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${renderTableRows(pageAgents, startIdx)}
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div class="ea-pagination-footer">
          <div class="ea-page-size-wrap">
            <span>Rows per page:</span>
            <select id="ea-page-size-select" class="ea-select" style="width:auto;padding:4px 24px 4px 8px;min-width:70px;">
              <option value="25" ${pagination.pageSize === 25 ? 'selected' : ''}>25</option>
              <option value="50" ${pagination.pageSize === 50 ? 'selected' : ''}>50</option>
              <option value="100" ${pagination.pageSize === 100 ? 'selected' : ''}>100</option>
              <option value="-1" ${pagination.pageSize === -1 ? 'selected' : ''}>All</option>
            </select>
          </div>

          <div class="ea-pagination-controls">
            <button class="ea-page-btn" id="ea-page-prev" ${pagination.page <= 1 ? 'disabled' : ''}>← Previous</button>
            <span style="font-size:0.8rem;color:#475569;margin:0 6px;">Page <strong>${pagination.page}</strong> of <strong>${totalPages}</strong></span>
            <button class="ea-page-btn" id="ea-page-next" ${pagination.page >= totalPages ? 'disabled' : ''}>Next →</button>
          </div>
        </div>
      </div>
    `;

    bindPortalEvents();
  }

  function renderTableRows(agents, startIdx) {
    if (!agents || agents.length === 0) {
      return `
        <tr>
          <td colspan="8">
            <div class="ea-empty-state">
              <div class="ea-empty-icon">🔍</div>
              <p style="font-weight:600;font-size:0.95rem;color:#1e293b;margin:0 0 4px;">No matching executives found</p>
              <p style="font-size:0.8rem;color:#64748b;margin:0;">Try adjusting your search query or department/team filters.</p>
            </div>
          </td>
        </tr>
      `;
    }

    return agents.map((ag, idx) => {
      const meta = ag.meta;
      const initial = (ag.name || 'A').charAt(0).toUpperCase();
      const color = getAvatarColor(ag.name);

      // Clean role label
      let roleBadgeHtml = '<span class="ea-badge ea-role-member">🎧 Telecaller</span>';
      const roleUpper = (meta.role || '').toUpperCase();
      if (roleUpper.includes('OWNER') || roleUpper.includes('ADMIN')) {
        roleBadgeHtml = '<span class="ea-badge ea-role-head">👑 Dept Head</span>';
      } else if (roleUpper.includes('MANAGER') || roleUpper.includes('LEAD')) {
        roleBadgeHtml = '<span class="ea-badge ea-role-leader">🛡️ Team Lead</span>';
      }

      // Department & Team labels
      const deptLabel = meta.deptName || 'General';
      const teamLabel = meta.teamName || 'No Team';

      return `
        <tr>
          <td style="color:#94a3b8;font-size:0.75rem;font-weight:600;">${startIdx + idx + 1}</td>
          
          <!-- Agent Cell -->
          <td>
            <div class="ea-agent-cell">
              <div class="ea-avatar" style="background:${color};">${initial}</div>
              <div class="ea-agent-info">
                <div class="ea-agent-name">
                  ${escapeHtml(ag.name || 'Unknown Executive')}
                </div>
                <div class="ea-agent-contact">
                  <span>✉️ ${escapeHtml(ag.email || '—')}</span>
                  ${ag.mobile ? `<span>📞 ${escapeHtml(ag.mobile)}</span>` : ''}
                </div>
              </div>
            </div>
          </td>

          <!-- Department -->
          <td>
            <span class="ea-badge ea-badge-dept">🏢 ${escapeHtml(deptLabel)}</span>
            ${meta.deptHead ? `
              <div class="ea-sub-lead">
                <span>Head: ${escapeHtml(meta.deptHead)}</span>
              </div>
            ` : ''}
          </td>

          <!-- Team -->
          <td>
            <span class="ea-badge ea-badge-team">👥 ${escapeHtml(teamLabel)}</span>
            ${meta.teamLeader ? `
              <div class="ea-sub-lead">
                <span>Lead: ${escapeHtml(meta.teamLeader)}</span>
              </div>
            ` : ''}
          </td>

          <!-- Role -->
          <td>${roleBadgeHtml}</td>

          <!-- Open Inbox Button -->
          <td style="text-align:center;">
            <button class="ea-btn-login" data-action="auto-login" data-uid="${ag.uid}" data-name="${escapeHtml(ag.name)}">
              <span>🚀 Open Inbox</span>
            </button>
          </td>

          <!-- Active Switch -->
          <td style="text-align:center;">
            <label class="ea-switch">
              <input type="checkbox" data-action="toggle-active" data-uid="${ag.uid}" ${ag.is_active ? 'checked' : ''} />
              <span class="ea-slider"></span>
            </label>
          </td>

          <!-- Actions -->
          <td style="text-align:center;">
            <div class="ea-row-actions" style="justify-content:center;">
              <button class="ea-action-icon-btn chats" title="View Chats" data-action="view-chats" data-uid="${ag.uid}" data-name="${escapeHtml(ag.name)}">
                💬
              </button>
              <button class="ea-action-icon-btn delete" title="Delete Agent" data-action="delete" data-uid="${ag.uid}" data-name="${escapeHtml(ag.name)}">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function bindPortalEvents() {
    const portal = document.getElementById('enhanced-agents-portal');
    if (!portal) return;

    // Search input
    const searchInput = document.getElementById('ea-search-input');
    const searchClear = document.getElementById('ea-search-clear');
    if (searchInput) {
      searchInput.oninput = (e) => {
        currentFilters.search = e.target.value;
        if (searchClear) searchClear.style.display = e.target.value ? 'block' : 'none';
        applyFilters();
      };
    }
    if (searchClear) {
      searchClear.onclick = () => {
        currentFilters.search = '';
        if (searchInput) searchInput.value = '';
        searchClear.style.display = 'none';
        applyFilters();
      };
    }

    // Department select
    const deptSelect = document.getElementById('ea-dept-select');
    if (deptSelect) {
      deptSelect.onchange = (e) => {
        currentFilters.department = e.target.value;
        currentFilters.team = 'ALL'; // Reset team on dept change
        applyFilters();
      };
    }

    // Team select
    const teamSelect = document.getElementById('ea-team-select');
    if (teamSelect) {
      teamSelect.onchange = (e) => {
        currentFilters.team = e.target.value;
        applyFilters();
      };
    }

    // Role select
    const roleSelect = document.getElementById('ea-role-select');
    if (roleSelect) {
      roleSelect.onchange = (e) => {
        currentFilters.role = e.target.value;
        applyFilters();
      };
    }

    // Status tabs
    const statusTabs = portal.querySelectorAll('.ea-status-tab');
    statusTabs.forEach(tab => {
      tab.onclick = () => {
        currentFilters.status = tab.getAttribute('data-status');
        applyFilters();
      };
    });

    // Reset filters button
    const resetBtn = document.getElementById('ea-btn-reset-filters');
    if (resetBtn) {
      resetBtn.onclick = () => {
        currentFilters.search = '';
        currentFilters.department = 'ALL';
        currentFilters.team = 'ALL';
        currentFilters.role = 'ALL';
        currentFilters.status = 'ALL';
        applyFilters();
      };
    }

    // Top action buttons
    const syncBtn = document.getElementById('ea-btn-sync');
    if (syncBtn) syncBtn.onclick = handleSyncCrm;

    const exportBtn = document.getElementById('ea-btn-export');
    if (exportBtn) exportBtn.onclick = handleExportCsv;

    // Pagination
    const pageSizeSelect = document.getElementById('ea-page-size-select');
    if (pageSizeSelect) {
      pageSizeSelect.onchange = (e) => {
        pagination.pageSize = parseInt(e.target.value, 10);
        pagination.page = 1;
        renderPortalState();
      };
    }

    const prevBtn = document.getElementById('ea-page-prev');
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (pagination.page > 1) {
          pagination.page--;
          renderPortalState();
        }
      };
    }

    const nextBtn = document.getElementById('ea-page-next');
    if (nextBtn) {
      nextBtn.onclick = () => {
        const pageSize = pagination.pageSize === -1 ? filteredAgents.length : pagination.pageSize;
        const totalPages = Math.max(1, Math.ceil(filteredAgents.length / pageSize));
        if (pagination.page < totalPages) {
          pagination.page++;
          renderPortalState();
        }
      };
    }

    // Row Actions via Event Delegation
    portal.onclick = (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      const uid = target.getAttribute('data-uid');
      const name = target.getAttribute('data-name');

      if (action === 'auto-login') {
        handleAutoLogin(uid, name);
      } else if (action === 'view-chats') {
        handleViewChats(uid, name);
      } else if (action === 'delete') {
        handleDeleteAgent(uid, name);
      }
    };

    // Toggle Checkboxes
    const toggles = portal.querySelectorAll('input[data-action="toggle-active"]');
    toggles.forEach(chk => {
      chk.onchange = (e) => {
        const uid = chk.getAttribute('data-uid');
        handleToggleActiveness(uid, e.target.checked);
      };
    });
  }

  // --------------------------------------------------------------------------
  // Lifecycle & Routing Watcher
  // --------------------------------------------------------------------------

  function isAgentLoginPage() {
    const params = new URLSearchParams(window.location.search);
    return params.get('page') === 'agent-login';
  }

  function mountEnhancedPortal() {
    if (!isAgentLoginPage()) {
      unmountEnhancedPortal();
      return;
    }

    // Find the main content container in WhatsCRM
    const main = document.querySelector('main');
    if (!main) return;

    let portal = document.getElementById('enhanced-agents-portal');
    if (!portal) {
      portal = document.createElement('div');
      portal.id = 'enhanced-agents-portal';
      main.appendChild(portal);
      main.classList.add('ea-active-container');
      isMounted = true;
      fetchAgents();
    } else {
      main.classList.add('ea-active-container');
    }
  }

  function unmountEnhancedPortal() {
    const portal = document.getElementById('enhanced-agents-portal');
    if (portal) {
      portal.remove();
    }
    const main = document.querySelector('main');
    if (main) {
      main.classList.remove('ea-active-container');
    }
    isMounted = false;
  }

  function checkRoute() {
    if (isAgentLoginPage()) {
      if (!isMounted || !document.getElementById('enhanced-agents-portal')) {
        mountEnhancedPortal();
      }
    } else {
      if (isMounted) {
        unmountEnhancedPortal();
      }
    }
  }

  // Hook into browser history state
  const originalPushState = history.pushState;
  history.pushState = function () {
    const res = originalPushState.apply(this, arguments);
    setTimeout(checkRoute, 50);
    return res;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function () {
    const res = originalReplaceState.apply(this, arguments);
    setTimeout(checkRoute, 50);
    return res;
  };

  window.addEventListener('popstate', checkRoute);

  // MutationObserver to watch when React mounts the main container
  const observer = new MutationObserver(() => {
    checkRoute();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      checkRoute();
    });
  } else {
    observer.observe(document.body, { childList: true, subtree: true });
    checkRoute();
  }

  // Periodic safeguard
  setInterval(checkRoute, 600);
})();
