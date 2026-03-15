export default function handler(req, res) {
  try {
    res.status(200).json({ message: 'API is working' });
  } catch (error) {
    console.error('Error in test API:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}