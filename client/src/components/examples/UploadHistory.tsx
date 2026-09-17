import UploadHistory from '../UploadHistory';

export default function UploadHistoryExample() {
  const mockUploads = [
    {
      id: '1',
      filename: 'september-2025-pl.csv',
      monthStart: '2025-09-01',
      status: 'exported' as const,
      uploadedAt: '2025-10-15T10:30:00Z',
    },
    {
      id: '2',
      filename: 'august-2025-pl.csv',
      monthStart: '2025-08-01',
      status: 'mapped' as const,
      uploadedAt: '2025-09-10T14:20:00Z',
    },
    {
      id: '3',
      filename: 'july-2025-pl.csv',
      monthStart: '2025-07-01',
      status: 'parsed' as const,
      uploadedAt: '2025-08-05T09:15:00Z',
    },
  ];

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <UploadHistory
        uploads={mockUploads}
        onViewReport={(id) => console.log('View report:', id)}
      onReviewMapping={(id) => console.log('Review mapping', id)}
      />
    </div>
  );
}
