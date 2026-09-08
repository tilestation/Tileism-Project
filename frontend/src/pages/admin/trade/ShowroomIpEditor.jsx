import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MonitorSmartphone, Plus, Trash2, Save, Wifi, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { api } from '../../../lib/api';
import { fmtDate } from './tradeFormat';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isValidIp = (v) => {
  const s = (v || '').trim();
  if (IPV4.test(s)) return s.split('.').every((n) => Number(n) <= 255);
  return s.includes(':') && s.length >= 3; // IPv6 — server validates strictly
};

export const ShowroomIpEditor = () => {
  const [ips, setIps] = useState([]);
  const [showrooms, setShowrooms] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [ipsRes, storesRes, meRes] = await Promise.all([api.getShowroomIps(), api.getShowrooms().catch(() => ({ data: [] })), api.getMyIp()]);
      setIps(ipsRes.data.ips || []);
      const list = Array.isArray(storesRes.data) ? storesRes.data : storesRes.data?.showrooms || storesRes.data?.stores || [];
      setShowrooms(list.filter((s) => s?.name));
      setMe(meRes.data);
      setDirty(false);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load showroom IPs');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const update = (idx, patch) => { setIps((p) => p.map((e, i) => (i === idx ? { ...e, ...patch } : e))); setDirty(true); };
  const remove = (idx) => { setIps((p) => p.filter((_, i) => i !== idx)); setDirty(true); };
  const addRow = (ip = '') => {
    const s = showrooms[0];
    setIps((p) => [...p, { id: null, ip, showroom_id: s?.id || null, showroom_name: s?.name || '', label: '' }]);
    setDirty(true);
  };
  const addThisComputer = () => {
    if (!me?.ip) return;
    if (ips.some((e) => e.ip === me.ip)) { toast.info('This computer is already registered'); return; }
    addRow(me.ip);
  };
  const setShowroom = (idx, id) => {
    const s = showrooms.find((x) => x.id === id);
    update(idx, { showroom_id: s?.id || null, showroom_name: s?.name || '' });
  };

  const save = async () => {
    const bad = ips.find((e) => !isValidIp(e.ip) || !e.showroom_name);
    if (bad) { toast.error('Every row needs a valid IP address and a showroom'); return; }
    setSaving(true);
    try {
      const { data } = await api.saveShowroomIps(ips.map((e) => ({ ...e, ip: e.ip.trim() })));
      setIps(data.ips || []);
      setDirty(false);
      toast.success(`Saved ${data.ips.length} showroom computer${data.ips.length === 1 ? '' : 's'}`);
      const meRes = await api.getMyIp();
      setMe(meRes.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="showroom-ip-editor">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2"><MonitorSmartphone className="h-4 w-4" />Showroom computers (IP addresses)</CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={addThisComputer} disabled={!me?.ip || loading} data-testid="add-this-computer">
              <Wifi className="h-3.5 w-3.5 mr-1" /> Add this computer
            </Button>
            <Button size="sm" variant="outline" onClick={() => addRow('')} data-testid="add-ip-row"><Plus className="h-3.5 w-3.5 mr-1" /> Add IP</Button>
            <Button size="sm" onClick={save} disabled={saving || !dirty} data-testid="save-showroom-ips"><Save className="h-3.5 w-3.5 mr-1" />{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Trade sign-ups from these IPs are recorded as <strong>In store</strong> even when nobody is logged into the admin on that machine.
          Register each showroom's broadband IP (click <em>Add this computer</em> while sitting at the till). Static IPs from your provider work best — if a showroom's IP changes, just add the new one.
        </p>
        {me && (
          <p className="text-xs flex items-center gap-1.5" data-testid="my-ip-line">
            {me.matched_showroom
              ? <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /><span className="text-emerald-700">This computer ({me.ip}) is registered as <strong>{me.matched_showroom}</strong>.</span></>
              : <span className="text-gray-500">This computer's IP is <span className="font-mono">{me.ip}</span> — not registered as a showroom yet.</span>}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {loading ? <p className="text-sm text-gray-400 py-4">Loading…</p> : ips.length === 0 ? (
          <p className="text-sm text-gray-400 py-4" data-testid="showroom-ips-empty">No showroom computers registered yet.</p>
        ) : (
          <div className="space-y-2">
            {ips.map((e, idx) => (
              <div key={e.id || `new-${idx}`} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center rounded-md border p-2" data-testid={`showroom-ip-row-${idx}`}>
                <Input value={e.ip} onChange={(ev) => update(idx, { ip: ev.target.value })} placeholder="e.g. 81.152.10.44" className={`font-mono h-9 ${e.ip && !isValidIp(e.ip) ? 'border-rose-400' : ''}`} data-testid={`showroom-ip-input-${idx}`} />
                {showrooms.length > 0 ? (
                  <select value={e.showroom_id || ''} onChange={(ev) => setShowroom(idx, ev.target.value)} className="h-9 px-2 border rounded-md text-sm" data-testid={`showroom-select-${idx}`}>
                    <option value="">Choose showroom…</option>
                    {showrooms.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : (
                  <Input value={e.showroom_name} onChange={(ev) => update(idx, { showroom_name: ev.target.value })} placeholder="Showroom name" className="h-9" />
                )}
                <Input value={e.label || ''} onChange={(ev) => update(idx, { label: ev.target.value })} placeholder="Label (e.g. Till PC, iPad)" className="h-9" data-testid={`showroom-label-${idx}`} />
                <div className="flex items-center gap-2 justify-end">
                  {e.added_at && <span className="text-[11px] text-gray-400 whitespace-nowrap hidden sm:inline" title={`Added by ${e.added_by || '—'}`}>{fmtDate(e.added_at)}</span>}
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={() => remove(idx)} data-testid={`remove-showroom-ip-${idx}`}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
