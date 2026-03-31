<template>
  <div ref="chartContainer" class="flex items-end gap-[2px]">
    <div
      v-for="(bar, i) in downsampledBars"
      :key="i"
      class="flex min-h-px flex-1 flex-col justify-end rounded-t-sm"
      :style="{ height: `${maxValue > 0 ? (bar.total / maxValue) * 100 : 0}%` }"
    >
      <div
        v-if="bar.error > 0"
        class="bg-error w-full rounded-t-sm"
        :style="{ height: `${bar.total > 0 ? (bar.error / bar.total) * 100 : 0}%` }"
      ></div>
      <div
        v-if="bar.fatal > 0"
        class="bg-error w-full"
        :style="{ height: `${bar.total > 0 ? (bar.fatal / bar.total) * 100 : 0}%` }"
      ></div>
      <div
        v-if="bar.warn > 0"
        class="bg-warning w-full"
        :style="{ height: `${bar.total > 0 ? (bar.warn / bar.total) * 100 : 0}%` }"
      ></div>
      <div
        v-if="bar.info > 0"
        class="bg-success w-full"
        :style="{ height: `${bar.total > 0 ? (bar.info / bar.total) * 100 : 0}%` }"
      ></div>
      <div
        v-if="bar.debug > 0"
        class="bg-info w-full"
        :style="{ height: `${bar.total > 0 ? (bar.debug / bar.total) * 100 : 0}%` }"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { LogFreq } from "@/models/Container";

const { chartData } = defineProps<{
  chartData: LogFreq[];
}>();

interface AggregatedBar {
  info: number;
  warn: number;
  error: number;
  debug: number;
  fatal: number;
  total: number;
}

const chartContainer = ref<HTMLElement | null>(null);
const { width } = useElementSize(chartContainer);

const BAR_WIDTH = 3;
const GAP = 2;

const availableBars = computed(() => Math.max(1, Math.floor(width.value / (BAR_WIDTH + GAP))));

const downsampledBars = computed(() => {
  const numBars = availableBars.value;
  if (chartData.length === 0) return [];

  if (chartData.length <= numBars) {
    return chartData.map((d) => ({
      info: d.info,
      warn: d.warn,
      error: d.error,
      debug: d.debug,
      fatal: d.fatal,
      total: d.info + d.warn + d.error + d.debug + d.fatal,
    }));
  }

  const bucketSize = Math.ceil(chartData.length / numBars);
  const result: AggregatedBar[] = [];

  for (let i = 0; i < numBars; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, chartData.length);
    const bucket = chartData.slice(start, end);

    const agg: AggregatedBar = { info: 0, warn: 0, error: 0, debug: 0, fatal: 0, total: 0 };
    for (const d of bucket) {
      agg.info += d.info;
      agg.warn += d.warn;
      agg.error += d.error;
      agg.debug += d.debug;
      agg.fatal += d.fatal;
    }
    agg.total = agg.info + agg.warn + agg.error + agg.debug + agg.fatal;
    result.push(agg);
  }

  return result.slice(-numBars);
});

const maxValue = computed(() => {
  const dataMax = Math.max(0, ...downsampledBars.value.map((b) => b.total));
  return Math.max(dataMax * 1.25, 1);
});
</script>
