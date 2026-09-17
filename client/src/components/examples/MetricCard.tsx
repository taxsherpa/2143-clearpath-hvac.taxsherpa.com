import MetricCard from '../MetricCard';

export default function MetricCardExample() {
  return (
    <div className="p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <MetricCard
        label="Revenue"
        value="$50,000"
        gaugeValue={75}
      />
      <MetricCard
        label="Fulfillment"
        value="$18,000"
        percentage="36%"
        status="healthy"
        benchmark="30-40%"
        gaugeValue={36}
      />
      <MetricCard
        label="CAC"
        value="$6,000"
        percentage="19%"
        status="warning"
        benchmark="15%"
        gaugeValue={19}
      />
      <MetricCard
        label="Operational Net Profit"
        value="$12,600"
        percentage="39%"
        status="warning"
        benchmark="60-70%"
        gaugeValue={39}
      />
    </div>
  );
}
