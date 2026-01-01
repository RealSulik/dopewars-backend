import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sortBy = searchParams.get('sortBy') || 'best_net_worth';
    const limit = parseInt(searchParams.get('limit') || '100');

    // Validate sortBy parameter
    const validSortFields = ['best_net_worth', 'total_ice', 'total_runs', 'total_wins'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'best_net_worth';

    // Get leaderboard data
    const { data, error } = await supabase
      .from('leaderboard')
      .select('*')
      .order(sortField, { ascending: false })
      .limit(limit);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      leaderboard: data || [],
      sortedBy: sortField
    });

  } catch (error: any) {
    console.error('Leaderboard error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch leaderboard' },
      { status: 500 }
    );
  }
}