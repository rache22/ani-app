export default async function handler(req, res) {
  // Set Full CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!googleApiKey) {
      return res.status(200).json({
        status: 'online',
        source: 'fallback_live',
        providers: [
          {
            id: '1',
            name: 'מאיה כהן',
            role: 'איפור & עיצוב שיער',
            rating: 4.9,
            price: '₪350',
            verified: true,
            isInstant: true,
            distance: '0.8 ק"מ'
          },
          {
            id: '2',
            name: 'HairStudio TLV',
            role: 'מספרה וסלון',
            address: 'דיזנגוף 140, תל אביב',
            rating: 4.8,
            price: '₪200',
            verified: false,
            isInstant: true,
            isGoogle: true,
            distance: '0.4 ק"מ'
          }
        ]
      });
    }

    const googleRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=32.0853,34.7818&radius=2000&type=beauty_salon&key=${googleApiKey}`
    );
    const data = await googleRes.json();

    return res.status(200).json({
      status: 'online',
      source: 'google_places_api',
      results: data.results || []
    });
  } catch (error) {
    return res.status(200).json({
      status: 'online',
      source: 'fallback_resilient',
      providers: [
        { id: '1', name: 'מאיה כהן', role: 'איפור & שיער', verified: true },
        { id: '2', name: 'HairStudio TLV', role: 'מספרה', verified: false }
      ]
    });
  }
}
