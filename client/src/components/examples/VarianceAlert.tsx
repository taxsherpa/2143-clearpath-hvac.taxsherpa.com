import VarianceAlert from '../VarianceAlert';

export default function VarianceAlertExample() {
  return (
    <div className="p-8 max-w-3xl mx-auto space-y-4">
      <VarianceAlert
        category="Customer Acquisition Cost (CAC)"
        current="19%"
        target="15%"
        variance={4}
        status="warning"
        recommendation="Your CAC is above target. Consider optimizing ad spend or improving conversion rates to reduce customer acquisition costs."
      />
      <VarianceAlert
        category="People"
        current="27%"
        target="15-20%"
        variance={7}
        status="danger"
        recommendation="People costs are significantly above target. Consider pushing more delivery labor into Fulfillment or trimming admin overhead."
      />
      <VarianceAlert
        category="Owner's Pay"
        current="39%"
        target="40-50%"
        variance={-1}
        status="healthy"
        recommendation="Owner's Pay is within healthy range. You're taking appropriate compensation relative to Real Revenue."
      />
    </div>
  );
}
