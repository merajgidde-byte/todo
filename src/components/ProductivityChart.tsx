import { useMemo } from 'react';
import { motion } from 'motion/react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AnimatedNumber } from './AnimatedNumber';
import { CATEGORIES, type Category, type Task, type ThemeMode } from '../types/task';

interface ProductivityChartProps {
  tasks: Task[];
  theme: ThemeMode;
  selectedCategory: Category | 'all';
  onSelectCategory: (category: Category | 'all') => void;
}

interface CategoryDatum {
  category: Category;
  completed: number;
  active: number;
  total: number;
  completionRate: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: CategoryDatum;
  }>;
}

function ChartTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const item = payload[0].payload;

  return (
    <div className="rounded-[10px] border border-slate-200 bg-white/95 px-3.5 py-2.5 text-sm shadow-sm backdrop-blur-sm dark:border-slate-700 dark:bg-slate-900/95">
      <p className="font-display font-semibold text-slate-900 dark:text-slate-100">
        {item.category}
      </p>
      <div className="mt-1 space-y-0.5 text-xs text-slate-600 tabular-nums dark:text-slate-300">
        <p>
          Completed:{' '}
          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
            {item.completed}
          </span>
        </p>
        <p>
          Remaining:{' '}
          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
            {item.active}
          </span>
        </p>
        <p>
          Completion rate:{' '}
          <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
            {item.completionRate}%
          </span>
        </p>
        <p className="pt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
          Click bar to filter task list
        </p>
      </div>
    </div>
  );
}

export function ProductivityChart({
  tasks,
  theme,
  selectedCategory,
  onSelectCategory,
}: ProductivityChartProps) {
  const { categoryData, totalCompleted, topCategory, completionRate } = useMemo(() => {
    const counts = new Map<Category, { completed: number; active: number }>();
    for (const cat of CATEGORIES) {
      counts.set(cat, { completed: 0, active: 0 });
    }

    for (const task of tasks) {
      const entry = counts.get(task.category) ?? { completed: 0, active: 0 };
      if (task.completed) {
        entry.completed += 1;
      } else {
        entry.active += 1;
      }
      counts.set(task.category, entry);
    }

    const data: CategoryDatum[] = CATEGORIES.map((category) => {
      const entry = counts.get(category) ?? { completed: 0, active: 0 };
      const total = entry.completed + entry.active;
      return {
        category,
        completed: entry.completed,
        active: entry.active,
        total,
        completionRate: total > 0 ? Math.round((entry.completed / total) * 100) : 0,
      };
    });

    const completedSum = data.reduce((sum, item) => sum + item.completed, 0);
    const totalTasks = tasks.length;
    const rate = totalTasks > 0 ? Math.round((completedSum / totalTasks) * 100) : 0;

    let leader: CategoryDatum | null = null;
    for (const item of data) {
      if (item.completed > 0 && (!leader || item.completed > leader.completed)) {
        leader = item;
      }
    }

    return {
      categoryData: data,
      totalCompleted: completedSum,
      topCategory: leader,
      completionRate: rate,
    };
  }, [tasks]);

  const isDark = theme === 'dark';
  const gridStroke = isDark ? '#1e293b' : '#e2e8f0';
  const tickColor = isDark ? '#94a3b8' : '#64748b';
  const mutedBarFill = isDark ? '#1e293b' : '#e2e8f0';
  const cursorFill = isDark ? 'rgba(59, 130, 246, 0.08)' : 'rgba(37, 99, 235, 0.05)';
  const gradientId = isDark ? 'tasklineBarDark' : 'tasklineBarLight';
  const activeGradientId = isDark ? 'tasklineBarActiveDark' : 'tasklineBarActiveLight';

  function handleBarClick(entry: CategoryDatum | undefined) {
    if (!entry) return;
    onSelectCategory(
      selectedCategory === entry.category ? 'all' : entry.category
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="productivity-heading"
      className="rounded-[14px] border border-[#dde2ea] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5 dark:border-[#233044] dark:bg-[#111827] dark:shadow-[0_1px_3px_rgba(0,0,0,0.28)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#dde2ea] pb-4 dark:border-[#233044]">
        <div>
          <h2
            id="productivity-heading"
            className="font-display text-lg font-bold tracking-tight text-[#0f172a] dark:text-[#f1f5f9]"
          >
            Productivity by Category
          </h2>
          <p className="mt-0.5 text-sm text-[#475569] dark:text-[#cbd5e1]">
            {totalCompleted > 0 && topCategory
              ? `Completed tasks across categories · Top category: ${topCategory.category} (${topCategory.completed})`
              : 'Complete a task above to track your category completion trends.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm text-[#475569] tabular-nums dark:text-[#cbd5e1]">
          <span>
            <AnimatedNumber
              value={totalCompleted}
              className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]"
            />{' '}
            completed
          </span>
          <span className="text-[#64748b] dark:text-[#94a3b8]" aria-hidden="true">
            ·
          </span>
          <span>
            <AnimatedNumber
              value={completionRate}
              className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]"
            />
            <span className="font-mono font-semibold text-[#0f172a] dark:text-[#f1f5f9]">
              %
            </span>{' '}
            overall rate
          </span>
          {selectedCategory !== 'all' && (
            <>
              <span className="text-[#64748b] dark:text-[#94a3b8]" aria-hidden="true">
                ·
              </span>
              <motion.button
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                whileTap={{ scale: 0.96 }}
                type="button"
                onClick={() => onSelectCategory('all')}
                className="font-medium text-[#2563eb] underline-offset-2 hover:underline dark:text-[#60a5fa]"
              >
                Showing {selectedCategory} (Reset)
              </motion.button>
            </>
          )}
        </div>
      </div>

      <div
        className="mt-4 h-[260px] w-full"
        role="img"
        aria-label="Bar chart of completed tasks by category"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={categoryData}
            margin={{ top: 12, right: 12, left: -16, bottom: 4 }}
          >
            <defs>
              <linearGradient id="tasklineBarLight" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" />
                <stop offset="100%" stopColor="#1d4ed8" />
              </linearGradient>
              <linearGradient id="tasklineBarActiveLight" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1d4ed8" />
                <stop offset="100%" stopColor="#1e3a8a" />
              </linearGradient>
              <linearGradient id="tasklineBarDark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
              <linearGradient id="tasklineBarActiveDark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#93c5fd" />
                <stop offset="100%" stopColor="#60a5fa" />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke={gridStroke}
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="category"
              tick={{ fill: tickColor, fontSize: 12, fontWeight: 500 }}
              axisLine={{ stroke: gridStroke }}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: tickColor, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: cursorFill }}
              content={<ChartTooltip />}
            />
            <Bar
              dataKey="completed"
              name="Completed Tasks"
              radius={[7, 7, 0, 0]}
              maxBarSize={48}
              cursor="pointer"
              isAnimationActive
              animationDuration={450}
              animationEasing="ease-out"
              onClick={(data) =>
                handleBarClick(data?.payload as CategoryDatum | undefined)
              }
            >
              {categoryData.map((entry) => {
                const isSelected = selectedCategory === entry.category;
                const isDimmed =
                  selectedCategory !== 'all' && selectedCategory !== entry.category;

                return (
                  <Cell
                    key={entry.category}
                    fill={
                      entry.completed > 0
                        ? isSelected
                          ? `url(#${activeGradientId})`
                          : `url(#${gradientId})`
                        : mutedBarFill
                    }
                    fillOpacity={isDimmed ? 0.35 : 1}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </motion.section>
  );
}
