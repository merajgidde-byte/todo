import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  Clock,
  LogIn,
  LogOut,
  Moon,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatedNumber } from './components/AnimatedNumber';
import { useFirebase } from './components/FirebaseProvider';
import { ProductivityChart } from './components/ProductivityChart';
import {
  clearCompletedTasksInFirestore,
  createTaskInFirestore,
  deleteTaskInFirestore,
  importLocalTasksToFirestore,
  subscribeToTasks,
  toggleTaskInFirestore,
  updateTaskInFirestore,
} from './services/taskService';
import {
  CATEGORIES,
  PRIORITIES,
  type Category,
  type FilterStatus,
  type Priority,
  type SortOption,
  type Task,
  type ThemeMode,
} from './types/task';

const LOCAL_TASKS_KEY = 'taskline_tasks_v1';
const THEME_KEY = 'taskline_theme_v1';

const PRIORITY_WEIGHT: Record<Priority, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

function readLegacyLocalTasks(): Task[] {
  try {
    const raw = localStorage.getItem(LOCAL_TASKS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof (item as Record<string, unknown>).title === 'string'
      )
      .map((item) => ({
        id: String(item.id || ''),
        title: String(item.title).trim().slice(0, 180),
        priority: PRIORITIES.includes(item.priority as Priority)
          ? (item.priority as Priority)
          : 'Medium',
        dueDate:
          typeof item.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)
            ? item.dueDate
            : '',
        category: CATEGORIES.includes(item.category as Category)
          ? (item.category as Category)
          : 'General',
        completed: Boolean(item.completed),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      }))
      .filter((item) => item.title.length > 0);
  } catch {
    return [];
  }
}

function clearLegacyLocalTasks(): void {
  try {
    localStorage.removeItem(LOCAL_TASKS_KEY);
  } catch {
    // Ignore storage restrictions
  }
}

function loadInitialTheme(): ThemeMode {
  try {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // Fallback to light
  }
  return 'light';
}

function getTodayISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type DueStatus = 'overdue' | 'today' | 'upcoming';

function formatDueDate(
  isoDate: string,
  isCompleted: boolean,
  today: string
): { text: string; status: DueStatus } | null {
  if (!isoDate) return null;
  const parts = isoDate.split('-').map(Number);
  const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
  const formatted = dateObj.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: parts[0] !== new Date().getFullYear() ? 'numeric' : undefined,
  });

  if (!isCompleted && isoDate < today) {
    return { text: `Overdue (${formatted})`, status: 'overdue' };
  }
  if (isoDate === today) {
    return {
      text: 'Due Today',
      status: isCompleted ? 'upcoming' : 'today',
    };
  }
  return { text: `Due ${formatted}`, status: 'upcoming' };
}

function extractReadableError(rawMessage: string): string {
  if (rawMessage.includes('Quota exceeded')) {
    return 'Daily Firestore free-tier quota exceeded. Quota resets tomorrow.';
  }
  try {
    const parsed = JSON.parse(rawMessage) as { error?: string };
    if (parsed && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON
  }
  return rawMessage || 'Unable to sync with Firestore. Please try again.';
}

export default function App() {
  const {
    user,
    authReady,
    authBusy,
    authError,
    signInWithGoogle,
    signOutUser,
    clearAuthError,
  } = useFirebase();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [pendingMutation, setPendingMutation] = useState(false);

  const [legacyTasks, setLegacyTasks] = useState<Task[]>(readLegacyLocalTasks);
  const [importingLocal, setImportingLocal] = useState(false);

  const [theme, setTheme] = useState<ThemeMode>(loadInitialTheme);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [selectedCategory, setSelectedCategory] = useState<Category | 'all'>('all');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [searchQuery, setSearchQuery] = useState('');

  // Composer state
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [dueDate, setDueDate] = useState('');
  const [category, setCategory] = useState<Category>('Work');
  const [titleError, setTitleError] = useState('');

  // Inline edit state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPriority, setEditPriority] = useState<Priority>('Medium');
  const [editDueDate, setEditDueDate] = useState('');
  const [editCategory, setEditCategory] = useState<Category>('General');
  const [editError, setEditError] = useState('');

  // Bulk confirmation, due-date alerts & accessibility announcement
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [todayISO, setTodayISO] = useState<string>(getTodayISO);
  const [dueToastOpen, setDueToastOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const titleInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editTitleInputRef = useRef<HTMLInputElement>(null);
  const clearCompletedBtnRef = useRef<HTMLButtonElement>(null);
  const bulkConfirmYesRef = useRef<HTMLButtonElement>(null);
  const lastAlertedDateRef = useRef<string>('');
  const seenUrgentIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Ignore storage restrictions
    }
  }, [theme]);

  useEffect(() => {
    if (!authReady) return;

    if (!user) {
      setTasks([]);
      setTasksLoading(false);
      setSyncError('');
      setEditingTaskId(null);
      setShowBulkConfirm(false);
      setSelectedCategory('all');
      return;
    }

    setTasksLoading(true);
    setSyncError('');

    const unsubscribe = subscribeToTasks(
      user.uid,
      (nextTasks) => {
        setTasks(nextTasks);
        setTasksLoading(false);
        setSyncError('');
      },
      (error) => {
        setTasksLoading(false);
        setSyncError(extractReadableError(error.message));
      }
    );

    return () => unsubscribe();
  }, [authReady, user]);

  useEffect(() => {
    if (editingTaskId && editTitleInputRef.current) {
      const input = editTitleInputRef.current;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [editingTaskId]);

  useEffect(() => {
    const syncDate = () => {
      const current = getTodayISO();
      setTodayISO((prev) => (prev === current ? prev : current));
    };
    const intervalId = window.setInterval(syncDate, 60_000);
    document.addEventListener('visibilitychange', syncDate);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', syncDate);
    };
  }, []);

  useEffect(() => {
    if (showBulkConfirm && bulkConfirmYesRef.current) {
      bulkConfirmYesRef.current.focus();
    }
  }, [showBulkConfirm]);

  const completedCount = useMemo(
    () => tasks.filter((t) => t.completed).length,
    [tasks]
  );
  const activeCount = tasks.length - completedCount;
  const completionRatio = tasks.length > 0 ? completedCount / tasks.length : 0;

  const { overdueTasks, dueTodayTasks } = useMemo(() => {
    const overdue: Task[] = [];
    const dueToday: Task[] = [];
    for (const task of tasks) {
      if (task.completed || !task.dueDate) continue;
      if (task.dueDate < todayISO) {
        overdue.push(task);
      } else if (task.dueDate === todayISO) {
        dueToday.push(task);
      }
    }
    return { overdueTasks: overdue, dueTodayTasks: dueToday };
  }, [tasks, todayISO]);

  useEffect(() => {
    if (!authReady || !user || tasksLoading) {
      if (!user) {
        setDueToastOpen(false);
        seenUrgentIdsRef.current.clear();
        lastAlertedDateRef.current = '';
      }
      return;
    }

    const urgentTasks = [...overdueTasks, ...dueTodayTasks];
    if (urgentTasks.length === 0) {
      setDueToastOpen(false);
      seenUrgentIdsRef.current.clear();
      return;
    }

    const urgentIds = new Set(urgentTasks.map((t) => `${t.id}:${t.dueDate}`));
    const isNewDay = lastAlertedDateRef.current !== todayISO;
    const hasNewUrgentTask = urgentTasks.some(
      (t) => !seenUrgentIdsRef.current.has(`${t.id}:${t.dueDate}`)
    );

    if (isNewDay || hasNewUrgentTask) {
      lastAlertedDateRef.current = todayISO;
      seenUrgentIdsRef.current = urgentIds;
      setDueToastOpen(true);
    } else {
      seenUrgentIdsRef.current = urgentIds;
    }
  }, [authReady, user, tasksLoading, overdueTasks, dueTodayTasks, todayISO]);

  const visibleTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = tasks.filter((task) => {
      if (filterStatus === 'active' && task.completed) return false;
      if (filterStatus === 'completed' && !task.completed) return false;
      if (selectedCategory !== 'all' && task.category !== selectedCategory) return false;
      if (query && !task.title.toLowerCase().includes(query)) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === 'priority') {
        const diff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
        if (diff !== 0) return diff;
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return b.createdAt - a.createdAt;
      }

      if (sortBy === 'dueDate') {
        if (a.dueDate && b.dueDate) {
          const cmp = a.dueDate.localeCompare(b.dueDate);
          if (cmp !== 0) return cmp;
        } else if (a.dueDate) {
          return -1;
        } else if (b.dueDate) {
          return 1;
        }
        return b.createdAt - a.createdAt;
      }

      return b.createdAt - a.createdAt;
    });
  }, [tasks, filterStatus, selectedCategory, searchQuery, sortBy]);

  function announce(message: string) {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(message));
  }

  function handleToggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;

    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Please enter a task title before adding.');
      titleInputRef.current?.focus();
      return;
    }

    setPendingMutation(true);
    setSyncError('');
    try {
      await createTaskInFirestore({
        userId: user.uid,
        title: trimmed,
        priority,
        dueDate,
        category,
      });

      if (filterStatus === 'completed') {
        setFilterStatus('all');
      }
      if (selectedCategory !== 'all' && selectedCategory !== category) {
        setSelectedCategory('all');
      }

      setTitle('');
      setPriority('Medium');
      setDueDate('');
      setCategory('Work');
      setTitleError('');

      announce(`Added task "${trimmed}"`);
      titleInputRef.current?.focus();
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    } finally {
      setPendingMutation(false);
    }
  }

  async function handleToggleStatus(task: Task) {
    if (!user) return;
    setSyncError('');
    const nextCompleted = !task.completed;
    try {
      await toggleTaskInFirestore(task.id, nextCompleted);
      announce(
        nextCompleted
          ? `Completed "${task.title}"`
          : `Marked "${task.title}" as active`
      );
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    }
  }

  function handleStartEdit(task: Task) {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditPriority(task.priority);
    setEditDueDate(task.dueDate);
    setEditCategory(task.category);
    setEditError('');
  }

  function handleCancelEdit() {
    setEditingTaskId(null);
    setEditError('');
  }

  async function handleSaveEdit(
    event: FormEvent<HTMLFormElement>,
    taskId: string
  ) {
    event.preventDefault();
    if (!user) return;

    const trimmed = editTitle.trim();
    if (!trimmed) {
      setEditError('Task title cannot be empty.');
      editTitleInputRef.current?.focus();
      return;
    }

    setPendingMutation(true);
    setSyncError('');
    try {
      await updateTaskInFirestore(taskId, {
        title: trimmed,
        priority: editPriority,
        dueDate: editDueDate,
        category: editCategory,
      });
      setEditingTaskId(null);
      setEditError('');
      announce(`Updated task "${trimmed}"`);
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    } finally {
      setPendingMutation(false);
    }
  }

  async function handleDeleteTask(task: Task) {
    if (!user) return;
    setSyncError('');
    try {
      await deleteTaskInFirestore(task.id);
      if (editingTaskId === task.id) {
        setEditingTaskId(null);
      }
      announce(`Deleted task "${task.title}"`);
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    }
  }

  function handleFilterChange(nextFilter: FilterStatus) {
    setFilterStatus(nextFilter);
    setEditingTaskId(null);
    setShowBulkConfirm(false);
  }

  function handleSortChange(nextSort: SortOption) {
    setSortBy(nextSort);
    setEditingTaskId(null);
  }

  async function handleConfirmBulkClear() {
    if (!user) return;
    const completedIds = tasks.filter((t) => t.completed).map((t) => t.id);
    if (completedIds.length === 0) return;

    setPendingMutation(true);
    setSyncError('');
    try {
      await clearCompletedTasksInFirestore(completedIds);
      setShowBulkConfirm(false);
      setEditingTaskId(null);
      announce(`Cleared ${completedIds.length} completed tasks`);
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    } finally {
      setPendingMutation(false);
    }
  }

  async function handleImportLegacyTasks() {
    if (!user || legacyTasks.length === 0) return;
    setImportingLocal(true);
    setSyncError('');
    try {
      await importLocalTasksToFirestore(user.uid, legacyTasks);
      clearLegacyLocalTasks();
      setLegacyTasks([]);
      announce(`Imported ${legacyTasks.length} local tasks to Firebase Firestore`);
    } catch (error) {
      setSyncError(
        extractReadableError(error instanceof Error ? error.message : String(error))
      );
    } finally {
      setImportingLocal(false);
    }
  }

  function handleDismissLegacyTasks() {
    clearLegacyLocalTasks();
    setLegacyTasks([]);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && searchQuery) {
      setSearchQuery('');
    }
  }

  const priorityClassMap: Record<Priority, string> = {
    High: 'text-[#dc2626] dark:text-[#f87171]',
    Medium: 'text-[#b45309] dark:text-[#fbbf24]',
    Low: 'text-[#15803d] dark:text-[#4ade80]',
  };

  const hasActiveFilter =
    tasks.length > 0 &&
    (filterStatus !== 'all' ||
      selectedCategory !== 'all' ||
      searchQuery.trim() !== '');

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-dvh flex-col">
        {/* Top Bar (3-zone contract: Brand — Nav Links — Primary Auth Action) */}
        <header className="sticky top-0 z-20 border-b border-[#dde2ea]/90 bg-white/85 backdrop-blur-md dark:border-[#233044]/90 dark:bg-[#111827]/85">
          <div className="mx-auto flex max-w-[1040px] items-center justify-between gap-8 px-4 py-3 sm:px-6">
            <a
              href="#top"
              id="top"
              className="font-display shrink-0 whitespace-nowrap text-lg font-extrabold tracking-tight text-[#0f172a] dark:text-[#f1f5f9]"
            >
              Taskline
            </a>

            <nav
              className="hidden items-center gap-6 text-sm font-medium text-[#475569] md:flex dark:text-[#cbd5e1]"
              aria-label="Quick filters"
            >
              {(
                [
                  { value: 'all', label: 'All Tasks' },
                  { value: 'active', label: 'Active' },
                  { value: 'completed', label: 'Completed' },
                ] as const
              ).map((item) => {
                const active = filterStatus === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => handleFilterChange(item.value)}
                    aria-current={active ? 'true' : 'false'}
                    className={`relative shrink-0 whitespace-nowrap py-2 transition-colors duration-150 ${
                      active
                        ? 'font-semibold text-[#0f172a] dark:text-[#f1f5f9]'
                        : 'hover:text-[#0f172a] dark:hover:text-[#f1f5f9]'
                    }`}
                  >
                    {item.label}
                    {active && (
                      <motion.span
                        layoutId="topNavUnderline"
                        transition={{ duration: 0.18, ease: EASE_OUT }}
                        className="absolute right-0 bottom-0 left-0 h-0.5 rounded-full bg-[#2563eb] dark:bg-[#60a5fa]"
                      />
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="shrink-0">
              {!authReady ? (
                <span className="inline-flex min-h-[40px] items-center text-sm text-[#64748b] dark:text-[#94a3b8]">
                  Connecting…
                </span>
              ) : user ? (
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  disabled={authBusy}
                  onClick={signOutUser}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-[#dde2ea] bg-white px-3.5 py-2 text-sm font-medium text-[#0f172a] transition-colors duration-150 hover:border-[#c5cdd9] hover:bg-[#f1f4f8] disabled:opacity-50 dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:hover:border-[#364761] dark:hover:bg-[#192335]"
                >
                  <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Sign Out</span>
                </motion.button>
              ) : (
                <motion.button
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  disabled={authBusy}
                  onClick={signInWithGoogle}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-[#1d4ed8] disabled:opacity-50 dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                >
                  <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{authBusy ? 'Signing in…' : 'Sign in with Google'}</span>
                </motion.button>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 sm:pt-7">
          {/* Workspace Header: Title, Live Counters, Completion Progress & Theme Switcher */}
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            aria-labelledby="workspace-heading"
            className="flex flex-col gap-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h1
                  id="workspace-heading"
                  className="font-display text-[clamp(1.625rem,2.75vw,2.125rem)] font-bold leading-tight tracking-tight text-[#0f172a] [text-wrap:balance] dark:text-[#f1f5f9]"
                >
                  Tasks
                </h1>
                {user && (
                  <p className="text-xs text-[#475569] dark:text-[#cbd5e1]">
                    Synced to Cloud Firestore for{' '}
                    <span className="font-semibold text-[#0f172a] dark:text-[#f1f5f9]">
                      {user.displayName || user.email}
                    </span>
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div
                  className="flex flex-wrap items-center gap-2 text-sm text-[#475569] tabular-nums dark:text-[#cbd5e1]"
                  aria-live="polite"
                >
                  <span>
                    <AnimatedNumber
                      value={activeCount}
                      className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]"
                    />{' '}
                    remaining
                  </span>
                  <span className="text-[#64748b] dark:text-[#94a3b8]" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    <AnimatedNumber
                      value={completedCount}
                      className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]"
                    />{' '}
                    completed
                  </span>
                  <span className="text-[#64748b] dark:text-[#94a3b8]" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    <AnimatedNumber
                      value={tasks.length}
                      className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]"
                    />{' '}
                    total
                  </span>
                  {overdueTasks.length > 0 && (
                    <>
                      <span
                        className="text-[#64748b] dark:text-[#94a3b8]"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-[#dc2626] dark:text-[#f87171]">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <AnimatedNumber
                          value={overdueTasks.length}
                          className="font-mono font-semibold"
                        />{' '}
                        overdue
                      </span>
                    </>
                  )}
                  {dueTodayTasks.length > 0 && (
                    <>
                      <span
                        className="text-[#64748b] dark:text-[#94a3b8]"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-[#b45309] dark:text-[#fbbf24]">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <AnimatedNumber
                          value={dueTodayTasks.length}
                          className="font-mono font-semibold"
                        />{' '}
                        due today
                      </span>
                    </>
                  )}
                </div>

                <motion.button
                  whileTap={{ scale: 0.96 }}
                  type="button"
                  onClick={handleToggleTheme}
                  aria-label="Switch color theme"
                  aria-pressed={theme === 'dark'}
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] border border-[#dde2ea] bg-white px-3 text-sm font-medium text-[#475569] transition-colors duration-150 hover:border-[#c5cdd9] hover:bg-[#f1f4f8] hover:text-[#0f172a] dark:border-[#233044] dark:bg-[#111827] dark:text-[#cbd5e1] dark:hover:border-[#364761] dark:hover:bg-[#192335] dark:hover:text-[#f1f5f9]"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {theme === 'dark' ? (
                      <motion.span
                        key="sun"
                        initial={{ opacity: 0, rotate: -45, scale: 0.8 }}
                        animate={{ opacity: 1, rotate: 0, scale: 1 }}
                        exit={{ opacity: 0, rotate: 45, scale: 0.8 }}
                        transition={{ duration: 0.15, ease: EASE_OUT }}
                        className="inline-flex items-center gap-2"
                      >
                        <Sun className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                        <span>Light Mode</span>
                      </motion.span>
                    ) : (
                      <motion.span
                        key="moon"
                        initial={{ opacity: 0, rotate: 45, scale: 0.8 }}
                        animate={{ opacity: 1, rotate: 0, scale: 1 }}
                        exit={{ opacity: 0, rotate: -45, scale: 0.8 }}
                        transition={{ duration: 0.15, ease: EASE_OUT }}
                        className="inline-flex items-center gap-2"
                      >
                        <Moon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                        <span>Dark Mode</span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.button>
              </div>
            </div>

            {user && tasks.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div
                  aria-label="Completion progress"
                  className="h-1.5 w-full overflow-hidden rounded-full bg-[#e5eaf2] dark:bg-[#1e293b]"
                >
                  <motion.div
                    className={`h-full w-full origin-left rounded-full transition-colors duration-300 ${
                      activeCount === 0
                        ? 'bg-[#16a34a] dark:bg-[#4ade80]'
                        : 'bg-[#2563eb] dark:bg-[#60a5fa]'
                    }`}
                    initial={false}
                    animate={{ scaleX: completionRatio }}
                    transition={{ duration: 0.35, ease: EASE_OUT }}
                  />
                </div>
                <AnimatePresence>
                  {activeCount === 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18, ease: EASE_OUT }}
                      className="flex items-center gap-1.5 text-xs font-semibold text-[#15803d] dark:text-[#4ade80]"
                    >
                      <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                      <span>All caught up — 100% of tasks completed</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.section>

          {/* Auth or Sync Error Banner */}
          <AnimatePresence>
            {(authError || syncError) && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.16, ease: EASE_OUT }}
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#dc2626] bg-white px-4 py-3 text-sm dark:border-[#f87171] dark:bg-[#111827]"
              >
                <p className="font-medium text-[#dc2626] dark:text-[#f87171]">
                  {authError || syncError}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearAuthError();
                    setSyncError('');
                  }}
                  className="inline-flex min-h-[36px] shrink-0 items-center rounded-[6px] border border-[#dde2ea] px-3 py-1 text-xs font-semibold text-[#0f172a] hover:bg-[#f1f4f8] dark:border-[#233044] dark:text-[#f1f5f9] dark:hover:bg-[#192335]"
                >
                  Dismiss
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading Auth State */}
          {!authReady ? (
            <section className="rounded-[14px] border border-[#dde2ea] bg-white p-8 text-center dark:border-[#233044] dark:bg-[#111827]">
              <p className="text-sm text-[#475569] dark:text-[#cbd5e1]">
                Checking Firebase authentication status…
              </p>
            </section>
          ) : !user ? (
            /* Signed-Out State */
            <motion.section
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              aria-label="Sign in to sync tasks"
              className="rounded-[14px] border border-[#dde2ea] bg-white p-8 text-center shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-10 dark:border-[#233044] dark:bg-[#111827] dark:shadow-[0_1px_3px_rgba(0,0,0,0.28)]"
            >
              <h2 className="font-display text-xl font-bold tracking-tight text-[#0f172a] dark:text-[#f1f5f9]">
                Sign in to sync your tasks with Firebase
              </h2>
              <p className="mx-auto mt-2 max-w-[48ch] text-sm text-[#475569] dark:text-[#cbd5e1]">
                Your tasks are stored securely in Cloud Firestore under your Google
                account so they stay up to date across sessions and devices.
              </p>
              <div className="mt-6 flex justify-center">
                <motion.button
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  disabled={authBusy}
                  onClick={signInWithGoogle}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] bg-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-[#1d4ed8] disabled:opacity-50 dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                >
                  <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{authBusy ? 'Signing in…' : 'Sign in with Google'}</span>
                </motion.button>
              </div>
            </motion.section>
          ) : (
            <>
              {/* Optional 1-click migration for previously saved browser tasks */}
              <AnimatePresence>
                {legacyTasks.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.18, ease: EASE_OUT }}
                    role="region"
                    aria-label="Import browser tasks"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#2563eb] bg-white px-4 py-3 dark:border-[#60a5fa] dark:bg-[#111827]"
                  >
                    <p className="text-sm text-[#0f172a] dark:text-[#f1f5f9]">
                      Found{' '}
                      <span className="font-mono font-semibold">
                        {legacyTasks.length}
                      </span>{' '}
                      {legacyTasks.length === 1 ? 'task' : 'tasks'} saved locally in
                      this browser. Import to your Cloud Firestore account?
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={importingLocal}
                        onClick={handleDismissLegacyTasks}
                        className="inline-flex min-h-[40px] shrink-0 items-center rounded-[6px] border border-[#dde2ea] px-3.5 py-1.5 text-sm font-medium text-[#475569] hover:bg-[#f1f4f8] dark:border-[#233044] dark:text-[#cbd5e1] dark:hover:bg-[#192335]"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        disabled={importingLocal}
                        onClick={handleImportLegacyTasks}
                        className="inline-flex min-h-[40px] shrink-0 items-center rounded-[6px] bg-[#2563eb] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-50 dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                      >
                        {importingLocal ? 'Importing…' : 'Import to Firestore'}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* CREATE: New Task Composer */}
              <motion.section
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                aria-label="Add a new task"
                className="rounded-[14px] border border-[#dde2ea] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] duration-200 focus-within:border-[#2563eb]/45 focus-within:shadow-[0_6px_20px_-6px_rgba(37,99,235,0.16)] sm:p-5 dark:border-[#233044] dark:bg-[#111827] dark:shadow-[0_1px_3px_rgba(0,0,0,0.28)] dark:focus-within:border-[#60a5fa]/45 dark:focus-within:shadow-[0_6px_20px_-6px_rgba(96,165,250,0.18)]"
              >
                <form
                  onSubmit={handleCreateTask}
                  className="grid grid-cols-1 gap-3"
                  noValidate
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <label
                      htmlFor="task-title-input"
                      className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                    >
                      Task title
                    </label>
                    <input
                      ref={titleInputRef}
                      id="task-title-input"
                      type="text"
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        if (titleError && e.target.value.trim().length > 0) {
                          setTitleError('');
                        }
                      }}
                      placeholder="What needs to get done?"
                      maxLength={180}
                      autoComplete="off"
                      aria-required="true"
                      aria-invalid={Boolean(titleError)}
                      aria-describedby="title-error"
                      className={`min-h-[44px] w-full rounded-[8px] border bg-white px-3.5 py-2.5 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 placeholder:text-[#64748b] focus:outline-none dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:placeholder:text-[#94a3b8] ${
                        titleError
                          ? 'border-[#dc2626] focus:ring-3 focus:ring-red-500/15 dark:border-[#f87171]'
                          : 'border-[#dde2ea] hover:border-[#c5cdd9] focus:border-[#2563eb] focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30'
                      }`}
                    />
                    <div className="flex min-h-[18px] items-center justify-between gap-2">
                      <div
                        id="title-error"
                        role="alert"
                        className="text-[0.8125rem] font-medium text-[#dc2626] dark:text-[#f87171]"
                      >
                        {titleError}
                      </div>
                      <AnimatePresence>
                        {title.length >= 140 && (
                          <motion.span
                            initial={{ opacity: 0, y: -3 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -3 }}
                            transition={{ duration: 0.15, ease: EASE_OUT }}
                            className={`font-mono text-xs tabular-nums ${
                              title.length >= 170
                                ? 'font-semibold text-[#b45309] dark:text-[#fbbf24]'
                                : 'text-[#64748b] dark:text-[#94a3b8]'
                            }`}
                          >
                            {title.length}/180
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
                    <div className="flex min-w-0 flex-col gap-1">
                      <label
                        htmlFor="task-priority-input"
                        className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                      >
                        Priority
                      </label>
                      <select
                        id="task-priority-input"
                        value={priority}
                        onChange={(e) => setPriority(e.target.value as Priority)}
                        className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2.5 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 hover:border-[#c5cdd9] focus:border-[#2563eb] focus:outline-none focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30"
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1">
                      <label
                        htmlFor="task-due-input"
                        className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                      >
                        Due date (optional)
                      </label>
                      <input
                        id="task-due-input"
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2.5 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 hover:border-[#c5cdd9] focus:border-[#2563eb] focus:outline-none focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30"
                      />
                    </div>

                    <div className="flex min-w-0 flex-col gap-1">
                      <label
                        htmlFor="task-category-input"
                        className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                      >
                        Category
                      </label>
                      <select
                        id="task-category-input"
                        value={category}
                        onChange={(e) => setCategory(e.target.value as Category)}
                        className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2.5 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 hover:border-[#c5cdd9] focus:border-[#2563eb] focus:outline-none focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>

                    <motion.button
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      type="submit"
                      disabled={pendingMutation}
                      className="group inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] bg-[#2563eb] px-[18px] py-2.5 text-[0.9375rem] font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-[#1d4ed8] disabled:opacity-50 dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                    >
                      <Plus
                        className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:rotate-90"
                        aria-hidden="true"
                      />
                      <span>Add Task</span>
                    </motion.button>
                  </div>
                </form>
              </motion.section>

              {/* READ: Search, Filter Tabs, Sort & Bulk Delete */}
              <section
                aria-label="Filter and sort tasks"
                className="flex flex-col gap-3"
              >
                <div className="relative min-w-0 flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3.5 h-[17px] w-[17px] -translate-y-1/2 text-[#64748b] dark:text-[#94a3b8]"
                    aria-hidden="true"
                  />
                  <label htmlFor="search-input" className="sr-only">
                    Search tasks by title
                  </label>
                  <input
                    ref={searchInputRef}
                    id="search-input"
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search tasks by title..."
                    autoComplete="off"
                    className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white py-2.5 pr-11 pl-10 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 placeholder:text-[#64748b] hover:border-[#c5cdd9] focus:border-[#2563eb] focus:outline-none focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:placeholder:text-[#94a3b8] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30"
                  />
                  <AnimatePresence>
                    {searchQuery.length > 0 && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ duration: 0.12 }}
                        type="button"
                        aria-label="Clear search"
                        onClick={() => {
                          setSearchQuery('');
                          searchInputRef.current?.focus();
                        }}
                        className="absolute top-1/2 right-0 inline-flex h-[44px] w-[44px] -translate-y-1/2 items-center justify-center rounded-[8px] text-[#64748b] hover:bg-[#f1f4f8] hover:text-[#0f172a] dark:text-[#94a3b8] dark:hover:bg-[#192335] dark:hover:text-[#f1f5f9]"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <div
                      role="tablist"
                      aria-label="Filter tasks by status"
                      className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-[10px] bg-[#e9edf4] p-1 dark:bg-[#1e293b]"
                    >
                      {(
                        [
                          { value: 'all', label: 'All' },
                          { value: 'active', label: 'Active' },
                          { value: 'completed', label: 'Completed' },
                        ] as const
                      ).map((tab) => {
                        const selected = filterStatus === tab.value;
                        return (
                          <button
                            key={tab.value}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            onClick={() => handleFilterChange(tab.value)}
                            className={`relative min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap rounded-[7px] px-3.5 py-2 text-sm transition-colors duration-150 md:min-h-[36px] md:py-1.5 ${
                              selected
                                ? 'font-semibold text-[#0f172a] dark:text-[#f1f5f9]'
                                : 'font-medium text-[#475569] hover:text-[#0f172a] dark:text-[#cbd5e1] dark:hover:text-[#f1f5f9]'
                            }`}
                          >
                            {selected && (
                              <motion.span
                                layoutId="activeFilterPill"
                                transition={{ duration: 0.18, ease: EASE_OUT }}
                                className="absolute inset-0 rounded-[7px] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-[#111827]"
                              />
                            )}
                            <span className="relative z-10">{tab.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    <AnimatePresence>
                      {selectedCategory !== 'all' && (
                        <motion.button
                          initial={{ opacity: 0, scale: 0.92, x: -6 }}
                          animate={{ opacity: 1, scale: 1, x: 0 }}
                          exit={{ opacity: 0, scale: 0.92, x: -6 }}
                          whileHover={{ y: -1 }}
                          whileTap={{ scale: 0.96 }}
                          transition={{ duration: 0.15, ease: EASE_OUT }}
                          type="button"
                          onClick={() => setSelectedCategory('all')}
                          aria-label={`Clear ${selectedCategory} category filter`}
                          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-[#2563eb]/35 bg-[#2563eb]/8 px-3 py-1.5 text-xs font-semibold text-[#1d4ed8] transition-colors duration-150 hover:bg-[#2563eb]/15 dark:border-[#60a5fa]/40 dark:bg-[#60a5fa]/12 dark:text-[#93c5fd] dark:hover:bg-[#60a5fa]/20"
                        >
                          <span>Category: {selectedCategory}</span>
                          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="sort-select"
                        className="whitespace-nowrap text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                      >
                        Sort by
                      </label>
                      <select
                        id="sort-select"
                        value={sortBy}
                        onChange={(e) =>
                          handleSortChange(e.target.value as SortOption)
                        }
                        className="min-h-[44px] min-w-[140px] rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2 text-[0.9375rem] text-[#0f172a] transition-colors duration-150 hover:border-[#c5cdd9] focus:border-[#2563eb] focus:outline-none focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:hover:border-[#364761] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30"
                      >
                        <option value="newest">Newest</option>
                        <option value="dueDate">Due Date</option>
                        <option value="priority">Priority</option>
                      </select>
                    </div>

                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      ref={clearCompletedBtnRef}
                      type="button"
                      disabled={completedCount === 0 || pendingMutation}
                      onClick={() => setShowBulkConfirm(true)}
                      className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-[#dde2ea] bg-transparent px-[18px] py-2.5 text-[0.9375rem] font-semibold text-[#dc2626] transition-colors duration-150 hover:border-[#dc2626] hover:bg-red-600/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#233044] dark:text-[#f87171] dark:hover:border-[#f87171] dark:hover:bg-red-400/15"
                    >
                      Clear Completed
                    </motion.button>
                  </div>
                </div>

                <AnimatePresence>
                  {showBulkConfirm && completedCount > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.16, ease: EASE_OUT }}
                      role="region"
                      aria-label="Confirm clearing completed tasks"
                      className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#dc2626] bg-white px-4 py-3 dark:border-[#f87171] dark:bg-[#111827]"
                    >
                      <p className="text-sm font-medium text-[#0f172a] dark:text-[#f1f5f9]">
                        {completedCount === 1
                          ? 'Remove 1 completed task permanently?'
                          : `Remove ${completedCount} completed tasks permanently?`}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={pendingMutation}
                          onClick={() => {
                            setShowBulkConfirm(false);
                            clearCompletedBtnRef.current?.focus();
                          }}
                          className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[6px] border border-[#dde2ea] bg-white px-4 py-2 text-sm font-semibold text-[#0f172a] hover:bg-[#f1f4f8] dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:hover:bg-[#192335]"
                        >
                          Cancel
                        </button>
                        <button
                          ref={bulkConfirmYesRef}
                          type="button"
                          disabled={pendingMutation}
                          onClick={handleConfirmBulkClear}
                          className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[6px] bg-[#dc2626] px-4 py-2 text-sm font-semibold text-white hover:bg-[#b91c1c] disabled:opacity-50 dark:bg-[#f87171] dark:text-[#0b1120] dark:hover:bg-[#fca5a5]"
                        >
                          {pendingMutation ? 'Removing…' : 'Remove Completed'}
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>

              {/* TASK LIST */}
              <section
                aria-label="Task list"
                className="overflow-hidden rounded-[14px] border border-[#dde2ea] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:border-[#233044] dark:bg-[#111827] dark:shadow-[0_1px_3px_rgba(0,0,0,0.28)]"
              >
                {tasksLoading ? (
                  <div className="divide-y divide-[#dde2ea] dark:divide-[#233044]">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className="flex items-center gap-3 p-4">
                        <div className="h-5 w-5 animate-pulse rounded-[6px] bg-[#eef1f5] dark:bg-[#1e293b]" />
                        <div className="flex-1 space-y-2">
                          <div className="h-4 w-2/3 animate-pulse rounded bg-[#eef1f5] dark:bg-[#1e293b]" />
                          <div className="h-3 w-1/3 animate-pulse rounded bg-[#eef1f5] dark:bg-[#1e293b]" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : visibleTasks.length > 0 ? (
                  <ul className="divide-y divide-[#dde2ea] dark:divide-[#233044]">
                    <AnimatePresence initial={false}>
                      {visibleTasks.map((task) => {
                        const isEditing = editingTaskId === task.id;
                        const dueInfo = formatDueDate(
                          task.dueDate,
                          task.completed,
                          todayISO
                        );

                        return (
                          <motion.li
                            key={task.id}
                            layout="position"
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, x: 18 }}
                            whileHover={isEditing ? undefined : { x: 2 }}
                            transition={{ duration: 0.18, ease: EASE_OUT }}
                            className="flex flex-col gap-3 p-4 transition-colors duration-150 hover:bg-[#f6f8fc] dark:hover:bg-[#172133]"
                          >
                            {isEditing ? (
                              <motion.form
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.15 }}
                                onSubmit={(e) => handleSaveEdit(e, task.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    handleCancelEdit();
                                  }
                                }}
                                noValidate
                                className="flex flex-col gap-3"
                              >
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
                                  <div className="flex min-w-0 flex-col gap-1">
                                    <label
                                      htmlFor={`edit-title-${task.id}`}
                                      className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                                    >
                                      Title
                                    </label>
                                    <input
                                      ref={editTitleInputRef}
                                      id={`edit-title-${task.id}`}
                                      type="text"
                                      value={editTitle}
                                      onChange={(e) => {
                                        setEditTitle(e.target.value);
                                        if (
                                          editError &&
                                          e.target.value.trim().length > 0
                                        ) {
                                          setEditError('');
                                        }
                                      }}
                                      maxLength={180}
                                      aria-invalid={Boolean(editError)}
                                      className={`min-h-[44px] w-full rounded-[8px] border bg-white px-3 py-2 text-[0.9375rem] text-[#0f172a] focus:outline-none dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] ${
                                        editError
                                          ? 'border-[#dc2626] focus:ring-3 focus:ring-red-500/15 dark:border-[#f87171]'
                                          : 'border-[#dde2ea] focus:border-[#2563eb] focus:ring-3 focus:ring-blue-600/20 dark:border-[#233044] dark:focus:border-[#60a5fa] dark:focus:ring-blue-400/30'
                                      }`}
                                    />
                                    {editError && (
                                      <div
                                        role="alert"
                                        className="text-[0.8125rem] font-medium text-[#dc2626] dark:text-[#f87171]"
                                      >
                                        {editError}
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex min-w-0 flex-col gap-1">
                                    <label
                                      htmlFor={`edit-priority-${task.id}`}
                                      className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                                    >
                                      Priority
                                    </label>
                                    <select
                                      id={`edit-priority-${task.id}`}
                                      value={editPriority}
                                      onChange={(e) =>
                                        setEditPriority(e.target.value as Priority)
                                      }
                                      className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2 text-[0.9375rem] text-[#0f172a] focus:border-[#2563eb] focus:outline-none dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:focus:border-[#60a5fa]"
                                    >
                                      {PRIORITIES.map((p) => (
                                        <option key={p} value={p}>
                                          {p}
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  <div className="flex min-w-0 flex-col gap-1">
                                    <label
                                      htmlFor={`edit-due-${task.id}`}
                                      className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                                    >
                                      Due date
                                    </label>
                                    <input
                                      id={`edit-due-${task.id}`}
                                      type="date"
                                      value={editDueDate}
                                      onChange={(e) =>
                                        setEditDueDate(e.target.value)
                                      }
                                      className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2 text-[0.9375rem] text-[#0f172a] focus:border-[#2563eb] focus:outline-none dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:focus:border-[#60a5fa]"
                                    />
                                  </div>

                                  <div className="flex min-w-0 flex-col gap-1">
                                    <label
                                      htmlFor={`edit-category-${task.id}`}
                                      className="text-[0.8125rem] font-semibold text-[#475569] dark:text-[#cbd5e1]"
                                    >
                                      Category
                                    </label>
                                    <select
                                      id={`edit-category-${task.id}`}
                                      value={editCategory}
                                      onChange={(e) =>
                                        setEditCategory(e.target.value as Category)
                                      }
                                      className="min-h-[44px] w-full rounded-[8px] border border-[#dde2ea] bg-white px-3 py-2 text-[0.9375rem] text-[#0f172a] focus:border-[#2563eb] focus:outline-none dark:border-[#233044] dark:bg-[#0f172a]/50 dark:text-[#f1f5f9] dark:focus:border-[#60a5fa]"
                                    >
                                      {CATEGORIES.map((c) => (
                                        <option key={c} value={c}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    disabled={pendingMutation}
                                    onClick={handleCancelEdit}
                                    className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-[#dde2ea] bg-white px-4 py-2 text-sm font-semibold text-[#0f172a] hover:bg-[#f1f4f8] dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:hover:bg-[#192335]"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="submit"
                                    disabled={pendingMutation}
                                    className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-50 dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                                  >
                                    Save
                                  </button>
                                </div>
                              </motion.form>
                            ) : (
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                  <motion.button
                                    whileTap={{ scale: 0.88 }}
                                    type="button"
                                    role="checkbox"
                                    aria-checked={task.completed}
                                    aria-label={
                                      task.completed
                                        ? `Mark "${task.title}" as active`
                                        : `Mark "${task.title}" as completed`
                                    }
                                    onClick={() => handleToggleStatus(task)}
                                    className="group relative -my-2.5 -ml-2.5 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[6px] md:-my-1.5 md:-ml-1.5 md:h-[36px] md:w-[36px]"
                                  >
                                    <AnimatePresence initial={false}>
                                      {task.completed && (
                                        <motion.span
                                          key="burst"
                                          initial={{ scale: 0.55, opacity: 0.65 }}
                                          animate={{ scale: 1.75, opacity: 0 }}
                                          exit={{ opacity: 0 }}
                                          transition={{ duration: 0.35, ease: EASE_OUT }}
                                          aria-hidden="true"
                                          className="pointer-events-none absolute h-5 w-5 rounded-[6px] border-2 border-[#2563eb] dark:border-[#60a5fa]"
                                        />
                                      )}
                                    </AnimatePresence>
                                    <span
                                      className={`relative inline-flex h-5 w-5 items-center justify-center rounded-[6px] border-[1.75px] transition-colors duration-150 ${
                                        task.completed
                                          ? 'border-[#2563eb] bg-[#2563eb] text-white dark:border-[#60a5fa] dark:bg-[#60a5fa] dark:text-[#0b1120]'
                                          : 'border-[#c5cdd9] bg-white group-hover:border-[#2563eb] dark:border-[#364761] dark:bg-[#111827] dark:group-hover:border-[#60a5fa]'
                                      }`}
                                    >
                                      <AnimatePresence initial={false}>
                                        {task.completed && (
                                          <motion.span
                                            key="check"
                                            initial={{ scale: 0.4, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            exit={{ scale: 0.4, opacity: 0 }}
                                            transition={{
                                              type: 'spring',
                                              stiffness: 500,
                                              damping: 28,
                                            }}
                                            className="inline-flex"
                                          >
                                            <Check
                                              className="h-[13px] w-[13px]"
                                              strokeWidth={2.75}
                                              aria-hidden="true"
                                            />
                                          </motion.span>
                                        )}
                                      </AnimatePresence>
                                    </span>
                                  </motion.button>

                                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <p
                                      className={`break-words text-[0.96875rem] font-medium transition-opacity duration-150 ${
                                        task.completed
                                          ? 'text-[#64748b] line-through opacity-70 dark:text-[#94a3b8]'
                                          : 'text-[#0f172a] dark:text-[#f1f5f9]'
                                      }`}
                                    >
                                      {task.title}
                                    </p>

                                    <div
                                      className={`flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-[#475569] tabular-nums dark:text-[#cbd5e1] ${
                                        task.completed ? 'opacity-70' : ''
                                      }`}
                                    >
                                      <span
                                        className={`font-semibold ${priorityClassMap[task.priority]}`}
                                      >
                                        {task.priority} priority
                                      </span>
                                      <span
                                        className="text-[#64748b] dark:text-[#94a3b8]"
                                        aria-hidden="true"
                                      >
                                        ·
                                      </span>
                                      <span>{task.category}</span>
                                      {dueInfo && (
                                        <>
                                          <span
                                            className="text-[#64748b] dark:text-[#94a3b8]"
                                            aria-hidden="true"
                                          >
                                            ·
                                          </span>
                                          <span
                                            className={`inline-flex items-center gap-1 ${
                                              dueInfo.status === 'overdue'
                                                ? 'font-semibold text-[#dc2626] dark:text-[#f87171]'
                                                : dueInfo.status === 'today'
                                                  ? 'font-semibold text-[#b45309] dark:text-[#fbbf24]'
                                                  : ''
                                            }`}
                                          >
                                            {dueInfo.status === 'overdue' && (
                                              <AlertTriangle
                                                className="h-3.5 w-3.5 shrink-0"
                                                aria-hidden="true"
                                              />
                                            )}
                                            {dueInfo.status === 'today' && (
                                              <Clock
                                                className="h-3.5 w-3.5 shrink-0"
                                                aria-hidden="true"
                                              />
                                            )}
                                            <span>{dueInfo.text}</span>
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex shrink-0 items-center gap-1">
                                  <motion.button
                                    whileHover={{ y: -1 }}
                                    whileTap={{ scale: 0.94 }}
                                    type="button"
                                    onClick={() => handleStartEdit(task)}
                                    aria-label={`Edit "${task.title}"`}
                                    className="group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[0.8125rem] font-medium text-[#64748b] transition-colors duration-150 hover:bg-[#eef1f5] hover:text-[#0f172a] md:min-h-[36px] md:min-w-[36px] dark:text-[#94a3b8] dark:hover:bg-[#1e293b] dark:hover:text-[#f1f5f9]"
                                  >
                                    <Pencil
                                      className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:-rotate-12"
                                      aria-hidden="true"
                                    />
                                    <span className="hidden sm:inline">Edit</span>
                                  </motion.button>
                                  <motion.button
                                    whileHover={{ y: -1 }}
                                    whileTap={{ scale: 0.94 }}
                                    type="button"
                                    onClick={() => handleDeleteTask(task)}
                                    aria-label={`Delete "${task.title}"`}
                                    className="group inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[0.8125rem] font-medium text-[#64748b] transition-colors duration-150 hover:bg-red-600/10 hover:text-[#dc2626] md:min-h-[36px] md:min-w-[36px] dark:text-[#94a3b8] dark:hover:bg-red-400/15 dark:hover:text-[#f87171]"
                                  >
                                    <Trash2
                                      className="h-4 w-4 shrink-0 transition-transform duration-150 group-hover:scale-110"
                                      aria-hidden="true"
                                    />
                                    <span className="hidden sm:inline">Delete</span>
                                  </motion.button>
                                </div>
                              </div>
                            )}
                          </motion.li>
                        );
                      })}
                    </AnimatePresence>
                  </ul>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="flex flex-col items-center gap-3 px-4 py-10 text-center"
                  >
                    <svg
                      className="h-16 w-16 text-[#64748b] opacity-85 dark:text-[#94a3b8]"
                      viewBox="0 0 64 64"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="12" y="10" width="40" height="44" rx="6" />
                      <motion.path
                        d="M22 24h20"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.28, delay: 0.05, ease: EASE_OUT }}
                      />
                      <motion.path
                        d="M22 34h14"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.28, delay: 0.12, ease: EASE_OUT }}
                      />
                      <motion.path
                        d="M22 44h10"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.28, delay: 0.18, ease: EASE_OUT }}
                      />
                      <motion.path
                        d="m40 41 3 3 6-7"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.35, delay: 0.24, ease: EASE_OUT }}
                      />
                    </svg>
                    <h2 className="font-display text-[1.0625rem] font-semibold text-[#0f172a] dark:text-[#f1f5f9]">
                      {hasActiveFilter ? 'No matching tasks' : 'No tasks yet'}
                    </h2>
                    <p className="max-w-[38ch] text-sm text-[#475569] dark:text-[#cbd5e1]">
                      {hasActiveFilter
                        ? 'Try clearing your search, category filter, or switching to a different status tab.'
                        : 'Add your first task using the form above to start organizing your day.'}
                    </p>
                    {hasActiveFilter && (
                      <motion.button
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.97 }}
                        type="button"
                        onClick={() => {
                          setFilterStatus('all');
                          setSelectedCategory('all');
                          setSearchQuery('');
                        }}
                        className="inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-[#dde2ea] bg-white px-4 py-2 text-sm font-semibold text-[#0f172a] hover:bg-[#f1f4f8] dark:border-[#233044] dark:bg-[#111827] dark:text-[#f1f5f9] dark:hover:bg-[#192335]"
                      >
                        Reset Filters
                      </motion.button>
                    )}
                  </motion.div>
                )}
              </section>

              {/* PRODUCTIVITY TRENDS: Recharts Bar Chart of Completed Tasks by Category */}
              <ProductivityChart
                tasks={tasks}
                theme={theme}
                selectedCategory={selectedCategory}
                onSelectCategory={setSelectedCategory}
              />
            </>
          )}
        </main>

        <footer className="mx-auto flex w-full max-w-[1040px] flex-wrap justify-between gap-2 px-4 pb-6 text-[0.8125rem] text-[#64748b] sm:px-6 dark:text-[#94a3b8]">
          <span>Tasks sync in real time with Firebase Cloud Firestore.</span>
          <span>Press Enter to add or save · Escape to cancel editing</span>
        </footer>

        {/* Due Today / Overdue Toast Notification */}
        <AnimatePresence>
          {dueToastOpen &&
            (overdueTasks.length > 0 || dueTodayTasks.length > 0) && (
              <motion.aside
                role="status"
                aria-live="polite"
                aria-label="Task due date reminder"
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.98 }}
                whileHover={{ y: -2 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className={`fixed right-4 bottom-4 left-4 z-30 rounded-[12px] border bg-white/95 p-3.5 shadow-lg backdrop-blur-md sm:right-6 sm:bottom-6 sm:left-auto sm:w-[360px] dark:bg-[#111827]/95 ${
                  overdueTasks.length > 0
                    ? 'border-[#dc2626]/60 dark:border-[#f87171]/60'
                    : 'border-[#d97706]/60 dark:border-[#fbbf24]/60'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] ${
                      overdueTasks.length > 0
                        ? 'bg-red-600/10 text-[#dc2626] dark:bg-red-400/15 dark:text-[#f87171]'
                        : 'bg-amber-600/10 text-[#b45309] dark:bg-amber-400/15 dark:text-[#fbbf24]'
                    }`}
                    aria-hidden="true"
                  >
                    {overdueTasks.length > 0 ? (
                      <AlertTriangle className="h-4 w-4" />
                    ) : (
                      <Clock className="h-4 w-4" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="font-display text-sm font-bold text-[#0f172a] dark:text-[#f1f5f9]">
                      {overdueTasks.length > 0 && dueTodayTasks.length > 0
                        ? `${overdueTasks.length} overdue · ${dueTodayTasks.length} due today`
                        : overdueTasks.length > 0
                          ? overdueTasks.length === 1
                            ? '1 task is overdue'
                            : `${overdueTasks.length} tasks are overdue`
                          : dueTodayTasks.length === 1
                            ? '1 task is due today'
                            : `${dueTodayTasks.length} tasks are due today`}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[#475569] dark:text-[#cbd5e1]">
                      {(overdueTasks[0] ?? dueTodayTasks[0])?.title}
                    </p>

                    <div className="mt-2.5 flex items-center gap-2">
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        type="button"
                        onClick={() => {
                          setFilterStatus('active');
                          setSortBy('dueDate');
                          setDueToastOpen(false);
                        }}
                        className="inline-flex min-h-[36px] shrink-0 items-center rounded-[6px] bg-[#2563eb] px-3 py-1.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-[#1d4ed8] dark:bg-[#60a5fa] dark:text-[#0b1120] dark:hover:bg-[#93c5fd]"
                      >
                        View Due Tasks
                      </motion.button>
                      <button
                        type="button"
                        onClick={() => setDueToastOpen(false)}
                        className="inline-flex min-h-[36px] shrink-0 items-center rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-[#475569] hover:bg-[#f1f4f8] hover:text-[#0f172a] dark:text-[#cbd5e1] dark:hover:bg-[#1e293b] dark:hover:text-[#f1f5f9]"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    aria-label="Close due date reminder"
                    onClick={() => setDueToastOpen(false)}
                    className="-mt-1 -mr-1 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[6px] text-[#64748b] hover:bg-[#f1f4f8] hover:text-[#0f172a] sm:h-8 sm:w-8 dark:text-[#94a3b8] dark:hover:bg-[#1e293b] dark:hover:text-[#f1f5f9]"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </motion.aside>
            )}
        </AnimatePresence>

        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
      </div>
    </MotionConfig>
  );
}
