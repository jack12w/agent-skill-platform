'use client';

import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import useTranslation from '../../../hooks/useTranslation';
import {
  PRESET_DAYS,
  SUB_STATUSES,
  dayToCnEndOfDay,
  getToken,
  toDateInput,
  type SubRow,
  type UserRow,
} from './subscriptions-shared';

interface Props {
  mode: 'add' | 'edit';
  pluginId: string;
  /** 编辑态必传 */
  sub?: SubRow;
  onClose: () => void;
  /** 保存成功（父组件负责关弹窗、提示、刷新列表） */
  onSaved: () => void;
}

/**
 * 手动添加 / 续期 与 编辑订阅 共用的弹窗。
 *
 * 二者字段高度重叠（用户 / 到期时间 / 状态），合成一个组件可以保证：
 *  · 状态默认值与白名单只有一处；
 *  · 「只改状态不碰到期时间」这条规则不会在某个入口被漏掉。
 */
export default function SubFormModal({ mode, pluginId, sub, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const isEdit = mode === 'edit';

  /* ---------------- 共用：状态 / 到期时间 ---------------- */
  // 新增与编辑的默认状态都是「生效中」
  const [status, setStatus] = useState<string>(isEdit ? sub?.status || 'active' : 'active');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  /* ---------------- 编辑：到期日 ---------------- */
  const origDay = isEdit ? toDateInput(sub?.expires_at) : '';
  const [day, setDay] = useState(origDay);

  /* ---------------- 新增：选用户 ---------------- */
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<UserRow[]>([]);
  const [pickedUser, setPickedUser] = useState<UserRow | null>(null);

  /* ---------------- 新增：时长 ---------------- */
  const [expiryMode, setExpiryMode] = useState<'days' | 'date'>('days');
  const [days, setDays] = useState('30');
  const [pickDate, setPickDate] = useState('');

  /** 用户搜索（400ms 防抖）；失败保留上次结果，不清空 */
  useEffect(() => {
    if (isEdit) return;
    const kw = userQuery.trim();
    if (!kw) {
      setUserResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      try {
        const res = await fetch(`/api/admin/users?search=${encodeURIComponent(kw)}&size=10`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setUserResults(Array.isArray(data?.items) ? data.items : []);
      } catch {
        /* 保留上次结果 */
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [userQuery, isEdit]);

  /**
   * 提交后这条订阅实际会落在哪个时刻 —— 用来判断「选了生效中但其实已经过期」。
   * 新增按天数时必然在未来，按到期日/编辑时按当天 23:59 算。
   */
  const effectiveExpiryMs = (): number | null => {
    if (isEdit) {
      if (!day) return null;
      return new Date(dayToCnEndOfDay(day)).getTime();
    }
    if (expiryMode === 'date') {
      if (!pickDate) return null;
      return new Date(dayToCnEndOfDay(pickDate)).getTime();
    }
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d <= 0) return null;
    return Date.now() + d * 86400_000;
  };

  // 选了生效中、到期时间却在过去 → 用户实际仍不可用，必须明确提示而不是让它悄悄不生效
  const expiryMs = effectiveExpiryMs();
  const activeButPast = status === 'active' && expiryMs !== null && expiryMs <= Date.now();

  const submit = async () => {
    setErr('');
    if (!pluginId) return;
    const token = getToken();
    if (!token) {
      setErr(t('admin.subActionFailed'));
      return;
    }

    const body: Record<string, unknown> = { status };

    if (isEdit) {
      if (!day) {
        setErr(t('admin.subNeedDate'));
        return;
      }
      // ⚠️ 只有日期真的被改动过才提交 expires_at。
      //    否则「打开弹窗、只把状态改成已取消、点保存」会把原本的
      //    08:00 到期时间静默推到当天 23:59（+16h 的无声偏移）。
      if (day !== origDay) body.expires_at = dayToCnEndOfDay(day);
    } else {
      if (!pickedUser) {
        setErr(t('admin.subNeedUser'));
        return;
      }
      body.user_id = pickedUser.id;
      if (expiryMode === 'days') {
        const d = Math.floor(Number(days));
        if (!Number.isFinite(d) || d <= 0) {
          setErr(t('admin.subNeedDays'));
          return;
        }
        body.days = d;
      } else {
        if (!pickDate) {
          setErr(t('admin.subNeedDate'));
          return;
        }
        body.expires_at = dayToCnEndOfDay(pickDate);
      }
    }

    setSaving(true);
    try {
      const url = isEdit
        ? `/api/admin/plugins/${pluginId}/subscriptions/${sub!.id}`
        : `/api/admin/plugins/${pluginId}/subscriptions`;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || String(res.status));
      onSaved();
    } catch (e: any) {
      setErr(e?.message || t('admin.subActionFailed'));
    } finally {
      setSaving(false);
    }
  };

  const field =
    'w-full px-2.5 py-1.5 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:border-brand-400';

  return (
    <Modal onClose={onClose} align="top" backdrop="bg-black/40">
      <div className="bg-white rounded-xl w-full max-w-xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
          <h2 className="font-semibold text-neutral-900">
            {isEdit ? t('admin.subEditTitle') : t('admin.subAddTitle')}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-700 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* 用户：编辑时只读展示，新增时搜索选择 */}
          <div>
            <span className="text-xs text-neutral-500">{t('admin.subUserSearch')}</span>
            {isEdit || pickedUser ? (
              <div className="mt-1 flex items-center justify-between gap-2 bg-brand-50 border border-brand-100 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-neutral-800 truncate">
                    {(isEdit
                      ? sub?.user_name || sub?.user_email
                      : pickedUser?.name || pickedUser?.email) || '—'}
                  </div>
                  <div className="text-[11px] text-neutral-400 truncate">
                    {(isEdit ? sub?.user_email : pickedUser?.email) || ''}
                  </div>
                </div>
                {!isEdit && (
                  <button
                    onClick={() => setPickedUser(null)}
                    className="text-xs text-neutral-500 hover:text-neutral-800 shrink-0"
                  >
                    {t('admin.subChangeUser')}
                  </button>
                )}
              </div>
            ) : (
              <>
                <input
                  className={`${field} mt-1`}
                  placeholder={t('admin.subUserPlaceholder')}
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                />
                {userQuery.trim() && (
                  <div className="mt-1 border border-neutral-200 rounded-lg divide-y divide-neutral-100 max-h-44 overflow-y-auto">
                    {userResults.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => {
                          setPickedUser(u);
                          setUserQuery('');
                          setUserResults([]);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-neutral-50"
                      >
                        <div className="text-sm text-neutral-800 truncate">
                          {u.name || u.email || u.id}
                        </div>
                        <div className="text-[11px] text-neutral-400 truncate">{u.email}</div>
                      </button>
                    ))}
                    {userResults.length === 0 && (
                      <div className="px-3 py-2 text-xs text-neutral-400">
                        {t('admin.subNoUserFound')}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 到期时间：新增可「按天数 / 按到期日」二选一，编辑只给具体日期 */}
          {isEdit ? (
            <label className="block">
              <span className="text-xs text-neutral-500">{t('admin.subThExpires')}</span>
              <input
                className={`${field} mt-1`}
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
              <span className="block mt-1 text-[11px] text-neutral-400">
                {t('admin.subDateHint')}
              </span>
            </label>
          ) : (
            <div>
              <span className="text-xs text-neutral-500">{t('admin.subAddDuration')}</span>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border border-neutral-200 overflow-hidden">
                  <button
                    onClick={() => setExpiryMode('days')}
                    className={`px-3 py-1.5 text-xs ${
                      expiryMode === 'days' ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600'
                    }`}
                  >
                    {t('admin.subModeDays')}
                  </button>
                  <button
                    onClick={() => setExpiryMode('date')}
                    className={`px-3 py-1.5 text-xs ${
                      expiryMode === 'date' ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600'
                    }`}
                  >
                    {t('admin.subModeDate')}
                  </button>
                </div>

                {expiryMode === 'days' ? (
                  <>
                    {PRESET_DAYS.map((d) => (
                      <button
                        key={d}
                        onClick={() => setDays(String(d))}
                        className={`px-2.5 py-1.5 text-xs rounded-lg border ${
                          Number(days) === d
                            ? 'border-brand-400 bg-brand-50 text-brand-700'
                            : 'border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        +{d}
                      </button>
                    ))}
                    <input
                      className={`${field} w-24`}
                      type="number"
                      min="1"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                    />
                    <span className="text-xs text-neutral-400">{t('admin.subDaysUnit')}</span>
                  </>
                ) : (
                  <>
                    <input
                      className={`${field} w-44`}
                      type="date"
                      value={pickDate}
                      onChange={(e) => setPickDate(e.target.value)}
                    />
                    <span className="text-xs text-neutral-400">{t('admin.subDateHint')}</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 状态 */}
          <label className="block">
            <span className="text-xs text-neutral-500">{t('admin.thStatus')}</span>
            <select
              className={`${field} mt-1`}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {SUB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === 'active'
                    ? t('admin.subStatusActive')
                    : s === 'expired'
                      ? t('admin.subStatusExpired')
                      : t('admin.subStatusCancelled')}
                </option>
              ))}
            </select>
          </label>

          {activeButPast && (
            <p className="text-[11px] text-amber-600">{t('admin.subActivePastHint')}</p>
          )}

          <p className="text-[11px] text-amber-600">{t('admin.subDelayHint')}</p>

          {err && <div className="text-xs text-red-600">{err}</div>}
        </div>

        <div className="px-5 py-4 border-t border-neutral-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm border border-neutral-200 rounded-lg hover:bg-neutral-50"
          >
            {t('admin.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? t('admin.subAdding') : t('admin.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
